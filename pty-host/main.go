// cxx-pty-host：每终端一个的 PTY 宿主进程。
//
// 职责严格限定（见 internal/TERMINAL-MODE.md §7.2）：创建 PTY、spawn 子进程、
// 转发 stdio、resize、signal、维护有界 raw output ring buffer、保存 daemon 写入的
// 不透明元数据、报告退出码。不解析终端流、不做网络、不做鉴权——信任边界是
// 注册目录的文件系统权限（0700）。
//
// 启动：cxx-pty-host --dir <sessionDir>
// sessionDir 内约定：
//
//	spawn.json  输入（daemon 写）：executable/args/cwd/env/cols/rows/ringBytes/meta
//	sock        unix socket（Windows 下该文件内容为 named pipe 名）
//	pid         host 自身 pid
//	meta.json   {v, hostPid, childPid, startedAt, meta}
//	exit.json   {code, signal, at}（子进程退出后写入）
//	host.log    host 自身日志
//
// IPC 帧协议（LE）：uint32 payloadLen | uint8 type | payload
//
//	c→h: 1 ATTACH(8B sinceSeq) | 2 WRITE(raw) | 3 RESIZE(2B cols,2B rows)
//	     4 SIGNAL(1B: 1=interrupt 2=eof 3=term 4=kill) | 5 CLOSE | 6 META
//	h→c: 0x81 HELLO(json) | 0x82 OUTPUT(8B seq + raw) | 0x83 EXIT(json)
//	     0x84 META(json) | 0x85 REPLAY_END(json)
//
// seq 是子进程输出的绝对字节偏移；ATTACH(sinceSeq) 从 ring 内重放缺口，
// 超出 ring 起点时 REPLAY_END.gap = true，由 daemon 决定重建快照。
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	protoV          = 1
	defaultRing     = 256 * 1024
	maxRing         = 64 * 1024 * 1024 // ringBytes 上限，防坏 spawn.json OOM
	outChunk        = 32 * 1024
	connOutbox      = 512
	lingerAfterExit = 2 * time.Hour
	closeForceAfter = 5 * time.Second
)

// 帧类型
const (
	tAttach    = 1
	tWrite     = 2
	tResize    = 3
	tSignal    = 4
	tClose     = 5
	tMeta      = 6
	tHello     = 0x81
	tOutput    = 0x82
	tExit      = 0x83
	tMetaR     = 0x84
	tReplayEnd = 0x85
)

// SIGNAL 载荷
const (
	sigInterrupt = 1
	sigEOF       = 2
	sigTerm      = 3
	sigKill      = 4
)

type spawnSpec struct {
	Executable string            `json:"executable"`
	Args       []string          `json:"args"`
	Cwd        string            `json:"cwd"`
	Env        map[string]string `json:"env"`
	Cols       int               `json:"cols"`
	Rows       int               `json:"rows"`
	RingBytes  int               `json:"ringBytes"`
	Meta       json.RawMessage   `json:"meta"`
}

type conn struct {
	c        net.Conn
	out      chan []byte
	done     chan struct{}
	killOnce sync.Once
	attached bool
	dead     bool
	startSeq uint64 // attach 时刻的 ring.total；广播帧按此裁剪，避免与重放重叠
}

// kill：幂等地终止连接。out 通道永不 close（避免并发 send panic），
// writer 经 done 退出。dead 标记与 conns 移除由调用方在 h.mu 内完成。
func (c *conn) kill() {
	c.killOnce.Do(func() { close(c.done) })
	c.c.Close()
}

type host struct {
	mu      sync.Mutex
	writeMu sync.Mutex
	ring    *ring
	conns   map[*conn]struct{}
	proc    ptyProc
	dir     string
	cols    int
	rows    int
	started time.Time

	exited     bool
	exitCode   int
	exitSignal string
	closing    bool

	listener net.Listener
}

func frame(t byte, payload []byte) []byte {
	f := make([]byte, 5+len(payload))
	binary.LittleEndian.PutUint32(f, uint32(len(payload)))
	f[4] = t
	copy(f[5:], payload)
	return f
}

func jsonFrame(t byte, v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte("{}")
	}
	return frame(t, b)
}

func main() {
	dir := flag.String("dir", "", "session directory")
	flag.Parse()
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "usage: cxx-pty-host --dir <sessionDir>")
		os.Exit(2)
	}
	if err := run(*dir); err != nil {
		log.Printf("fatal: %v", err)
		os.Exit(1)
	}
}

func run(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "host.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err == nil {
		log.SetOutput(logFile)
	}
	log.Printf("cxx-pty-host protoV=%d pid=%d dir=%s", protoV, os.Getpid(), dir)

	raw, err := os.ReadFile(filepath.Join(dir, "spawn.json"))
	if err != nil {
		return fmt.Errorf("read spawn.json: %w", err)
	}
	var spec spawnSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return fmt.Errorf("parse spawn.json: %w", err)
	}
	if spec.Cols <= 0 {
		spec.Cols = 80
	}
	if spec.Rows <= 0 {
		spec.Rows = 24
	}
	if spec.RingBytes <= 0 {
		spec.RingBytes = defaultRing
	}
	if spec.RingBytes > maxRing {
		spec.RingBytes = maxRing // 坏 spawn.json 不能靠一个巨值把 host OOM 掉
	}
	if st, err := os.Stat(spec.Cwd); err != nil || !st.IsDir() {
		return fmt.Errorf("cwd 不存在或不是目录: %s", spec.Cwd)
	}

	proc, err := startProc(&spec)
	if err != nil {
		return fmt.Errorf("spawn: %w", err)
	}
	// 子进程已继承完整环境，spawn.json 里的 env（常含 API 密钥）不再需要——
	// 就地清掉，别让机密在会话整个生命周期里躺在磁盘上。host 不会重读它
	//（reattach 连的是活着的 host，不重新 spawn）。
	if len(spec.Env) > 0 {
		if stripped, e := json.Marshal(map[string]any{
			"executable": spec.Executable, "cwd": spec.Cwd, "cols": spec.Cols,
			"rows": spec.Rows, "ringBytes": spec.RingBytes, "meta": spec.Meta,
			"envStripped": true,
		}); e == nil {
			os.WriteFile(filepath.Join(dir, "spawn.json"), stripped, 0o600)
		}
	}

	h := &host{
		ring:    newRing(spec.RingBytes),
		conns:   map[*conn]struct{}{},
		proc:    proc,
		dir:     dir,
		cols:    spec.Cols,
		rows:    spec.Rows,
		started: time.Now(),
	}

	if err := os.WriteFile(filepath.Join(dir, "pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0o600); err != nil {
		return err
	}
	metaOut, _ := json.Marshal(map[string]any{
		"v":         protoV,
		"hostPid":   os.Getpid(),
		"childPid":  proc.Pid(),
		"startedAt": h.started.UnixMilli(),
		"meta":      spec.Meta,
	})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), metaOut, 0o600); err != nil {
		return err
	}

	ln, err := listenIPC(dir)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	h.listener = ln
	log.Printf("child pid=%d listening", proc.Pid())

	// SIGTERM/SIGINT → 与 CLOSE 相同的优雅收尾
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Printf("signal received, closing")
		h.close()
	}()

	go h.readLoop()
	go h.waitLoop()

	for {
		c, err := ln.Accept()
		if err != nil {
			// listener 关闭 = shutdown
			return nil
		}
		go h.serveConn(c)
	}
}

// readLoop：PTY 输出 → ring + 广播。持续到 PTY 读错误（子进程侧全部关闭）。
//
// 背压语义：daemon 是本机唯一消费者，outbox 满时**阻塞读 PTY**（→ PTY master
// 缓冲填满 → 子进程写 tty 阻塞 → 洪流自然限速，与桌面终端行为一致），而不是
// 踢断连接。只有阻塞超过 sendStall 的连接才视为死连接踢掉。手机侧慢消费者的
// 丢弃由 daemon 的 LOW 队列负责（TERMINAL-MODE.md §10.2），不在 host 层。
func (h *host) readLoop() {
	buf := make([]byte, outChunk)
	for {
		n, err := h.proc.Read(buf)
		if n > 0 {
			h.broadcast(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

const sendStall = 5 * time.Second

func (h *host) broadcast(p []byte) {
	h.mu.Lock()
	seq := h.ring.total
	h.ring.append(p)
	targets := make([]*conn, 0, len(h.conns))
	for c := range h.conns {
		if c.attached && !c.dead {
			targets = append(targets, c)
		}
	}
	// startSeq 连同 conn 一起在 mu 内快照：客户端可能重复 ATTACH 改写 startSeq，
	// 锁外裸读会与之数据竞争（race detector 报警），且读到旧值会重发已重放过的字节
	type target struct {
		c  *conn
		st uint64
	}
	tgts := make([]target, len(targets))
	for i, c := range targets {
		tgts[i] = target{c, c.startSeq}
	}
	h.mu.Unlock()

	for _, tg := range tgts {
		if seq+uint64(len(p)) <= tg.st {
			continue // 已被 attach 重放覆盖
		}
		data, fseq := p, seq
		if seq < tg.st {
			data, fseq = p[tg.st-seq:], tg.st
		}
		h.send(tg.c, outputFrame(fseq, data))
	}
}

func (h *host) send(c *conn, f []byte) {
	select {
	case c.out <- f: // 快路径
		return
	case <-c.done:
		return
	default:
	}
	t := time.NewTimer(sendStall)
	defer t.Stop()
	select {
	case c.out <- f:
	case <-c.done:
	case <-t.C:
		h.mu.Lock()
		c.dead = true
		delete(h.conns, c)
		h.mu.Unlock()
		c.kill()
		log.Printf("conn stalled >%s, dropped", sendStall)
	}
}

func outputFrame(seq uint64, data []byte) []byte {
	payload := make([]byte, 8+len(data))
	binary.LittleEndian.PutUint64(payload, seq)
	copy(payload[8:], data)
	return frame(tOutput, payload)
}

// enqueueCtl：控制帧（hello/replay/exit/meta）入队，调用方持有 h.mu。
// 这些帧量小；outbox 满说明连接已死，直接踢。
func (h *host) enqueueCtl(c *conn, f []byte) {
	if c.dead {
		return
	}
	select {
	case c.out <- f:
	default:
		c.dead = true
		delete(h.conns, c)
		c.kill()
		log.Printf("conn ctl overflow, dropped")
	}
}

func (h *host) waitLoop() {
	code, sig := h.proc.Wait()
	h.mu.Lock()
	h.exited = true
	h.exitCode = code
	h.exitSignal = sig
	closing := h.closing
	exitJSON, _ := json.Marshal(map[string]any{"code": code, "signal": sig, "at": time.Now().UnixMilli()})
	_ = os.WriteFile(filepath.Join(h.dir, "exit.json"), exitJSON, 0o600)
	f := jsonFrame(tExit, map[string]any{"code": code, "signal": sig})
	for c := range h.conns {
		if c.attached {
			h.enqueueCtl(c, f)
		}
	}
	h.mu.Unlock()
	log.Printf("child exited code=%d signal=%q closing=%v", code, sig, closing)

	if closing {
		time.Sleep(500 * time.Millisecond) // 让 EXIT 帧发出去
		h.shutdown()
		return
	}
	// 退出后保留 ring 供 daemon 读取最后画面，linger 到期自行退出
	time.Sleep(lingerAfterExit)
	h.shutdown()
}

func (h *host) shutdown() {
	h.mu.Lock()
	for c := range h.conns {
		c.dead = true
		c.kill()
		delete(h.conns, c)
	}
	h.mu.Unlock()
	if h.listener != nil {
		h.listener.Close()
	}
	cleanupIPC(h.dir)
	_ = os.Remove(filepath.Join(h.dir, "pid"))
	log.Printf("shutdown")
	os.Exit(0)
}

// close：CLOSE 帧 / SIGTERM 的共同路径——先优雅后强杀。
func (h *host) close() {
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		return
	}
	h.closing = true
	exited := h.exited
	h.mu.Unlock()
	if exited {
		h.shutdown()
		return
	}
	_ = h.proc.Terminate(false)
	go func() {
		time.Sleep(closeForceAfter)
		h.mu.Lock()
		exited := h.exited
		h.mu.Unlock()
		if !exited {
			_ = h.proc.Terminate(true)
		}
	}()
}

func (h *host) serveConn(nc net.Conn) {
	c := &conn{c: nc, out: make(chan []byte, connOutbox), done: make(chan struct{})}
	h.mu.Lock()
	h.conns[c] = struct{}{}
	hello := jsonFrame(tHello, map[string]any{
		"v":          protoV,
		"hostPid":    os.Getpid(),
		"childPid":   h.proc.Pid(),
		"exited":     h.exited,
		"exitCode":   h.exitCode,
		"exitSignal": h.exitSignal,
		"cols":       h.cols,
		"rows":       h.rows,
		"seq":        h.ring.total,
		"ringStart":  h.ring.start(),
		"startedAt":  h.started.UnixMilli(),
	})
	h.enqueueCtl(c, hello)
	h.mu.Unlock()

	// writer
	go func() {
		for {
			select {
			case f := <-c.out:
				nc.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if _, err := nc.Write(f); err != nil {
					h.dropConn(c)
					return
				}
			case <-c.done:
				return
			}
		}
	}()

	// reader
	header := make([]byte, 5)
	for {
		if _, err := readFull(nc, header); err != nil {
			break
		}
		n := binary.LittleEndian.Uint32(header)
		t := header[4]
		if n > 1024*1024 {
			log.Printf("oversized frame %d, dropping conn", n)
			break
		}
		payload := make([]byte, n)
		if _, err := readFull(nc, payload); err != nil {
			break
		}
		h.handleFrame(c, t, payload)
	}

	h.dropConn(c)
}

func (h *host) dropConn(c *conn) {
	h.mu.Lock()
	c.dead = true
	delete(h.conns, c)
	h.mu.Unlock()
	c.kill()
}

func readFull(nc net.Conn, buf []byte) (int, error) {
	got := 0
	for got < len(buf) {
		n, err := nc.Read(buf[got:])
		got += n
		if err != nil {
			return got, err
		}
	}
	return got, nil
}

func (h *host) handleFrame(c *conn, t byte, payload []byte) {
	switch t {
	case tAttach:
		var since uint64
		if len(payload) >= 8 {
			since = binary.LittleEndian.Uint64(payload)
		}
		h.attach(c, since)
	case tWrite:
		h.writeMu.Lock()
		_, err := h.proc.Write(payload)
		h.writeMu.Unlock()
		if err != nil {
			log.Printf("pty write: %v", err)
		}
	case tResize:
		if len(payload) >= 4 {
			cols := int(binary.LittleEndian.Uint16(payload))
			rows := int(binary.LittleEndian.Uint16(payload[2:]))
			if cols > 0 && rows > 0 {
				if err := h.proc.Resize(cols, rows); err == nil {
					h.mu.Lock()
					h.cols, h.rows = cols, rows
					h.mu.Unlock()
				}
			}
		}
	case tSignal:
		if len(payload) < 1 {
			return
		}
		switch payload[0] {
		case sigInterrupt:
			h.writeMu.Lock()
			_, _ = h.proc.Write([]byte{0x03})
			h.writeMu.Unlock()
		case sigEOF:
			h.writeMu.Lock()
			_, _ = h.proc.Write(eofBytes())
			h.writeMu.Unlock()
		case sigTerm:
			_ = h.proc.Terminate(false)
		case sigKill:
			_ = h.proc.Terminate(true)
		}
	case tClose:
		h.close()
	case tMeta:
		raw, err := os.ReadFile(filepath.Join(h.dir, "meta.json"))
		if err != nil {
			raw = []byte("{}")
		}
		h.mu.Lock()
		h.enqueueCtl(c, frame(tMetaR, raw))
		h.mu.Unlock()
	}
}

// attach：在 ring 锁内完成重放入队 + startSeq 标定 + 订阅标记。
// 重放覆盖 [from, total)，广播按 startSeq=total 裁剪 → 无缝无重。
func (h *host) attach(c *conn, since uint64) {
	h.mu.Lock()
	data, from, gap := h.ring.since(since)
	for off := 0; off < len(data); off += outChunk {
		end := off + outChunk
		if end > len(data) {
			end = len(data)
		}
		h.enqueueCtl(c, outputFrame(from+uint64(off), data[off:end]))
	}
	h.enqueueCtl(c, jsonFrame(tReplayEnd, map[string]any{"from": from, "gap": gap, "next": h.ring.total}))
	if h.exited {
		h.enqueueCtl(c, jsonFrame(tExit, map[string]any{"code": h.exitCode, "signal": h.exitSignal}))
	}
	c.startSeq = h.ring.total
	c.attached = true
	h.mu.Unlock()
}
