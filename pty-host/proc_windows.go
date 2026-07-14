//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/UserExistsError/conpty"
	"github.com/Microsoft/go-winio"
)

type ptyProc interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Pid() int
	Terminate(force bool) error
	Wait() (code int, signal string)
}

type winProc struct {
	cpty *conpty.ConPty
}

func startProc(spec *spawnSpec) (ptyProc, error) {
	args := append([]string{spec.Executable}, spec.Args...)
	cmdline := windowsJoinArgs(args)
	opts := []conpty.ConPtyOption{
		conpty.ConPtyDimensions(spec.Cols, spec.Rows),
		conpty.ConPtyWorkDir(spec.Cwd),
	}
	if len(spec.Env) > 0 {
		env := make([]string, 0, len(spec.Env))
		for k, v := range spec.Env {
			env = append(env, k+"="+v)
		}
		opts = append(opts, conpty.ConPtyEnv(env))
	}
	cpty, err := conpty.Start(cmdline, opts...)
	if err != nil {
		return nil, err
	}
	return &winProc{cpty: cpty}, nil
}

// windowsJoinArgs：按 CommandLineToArgvW 的反向规则拼接（MSVC 引用约定）。
func windowsJoinArgs(args []string) string {
	var b strings.Builder
	for i, a := range args {
		if i > 0 {
			b.WriteByte(' ')
		}
		if a != "" && !strings.ContainsAny(a, " \t\"") {
			b.WriteString(a)
			continue
		}
		b.WriteByte('"')
		backslashes := 0
		for _, r := range a {
			switch r {
			case '\\':
				backslashes++
			case '"':
				b.WriteString(strings.Repeat("\\", backslashes*2+1))
				b.WriteByte('"')
				backslashes = 0
			default:
				if backslashes > 0 {
					b.WriteString(strings.Repeat("\\", backslashes))
					backslashes = 0
				}
				b.WriteRune(r)
			}
		}
		if backslashes > 0 {
			b.WriteString(strings.Repeat("\\", backslashes*2))
		}
		b.WriteByte('"')
	}
	return b.String()
}

func (p *winProc) Read(b []byte) (int, error)  { return p.cpty.Read(b) }
func (p *winProc) Write(b []byte) (int, error) { return p.cpty.Write(b) }

func (p *winProc) Resize(cols, rows int) error { return p.cpty.Resize(cols, rows) }

func (p *winProc) Pid() int { return p.cpty.Pid() }

// Terminate：taskkill /T 带走整棵进程树（对应 unix 的负 pid 组杀）。
func (p *winProc) Terminate(force bool) error {
	args := []string{"/T", "/PID", strconv.Itoa(p.cpty.Pid())}
	if force {
		args = append([]string{"/F"}, args...)
	}
	return exec.Command("taskkill", args...).Run()
}

func (p *winProc) Wait() (int, string) {
	code, err := p.cpty.Wait(context.Background())
	if err != nil {
		return -1, ""
	}
	return int(code), ""
}

// Windows 控制台的 EOF 约定是 Ctrl+Z + Enter。
func eofBytes() []byte { return []byte{0x1a, '\r'} }

// listenIPC：named pipe，仅当前用户可访问；pipe 名写入 sock 文件供 client 发现。
// pipe 名带每会话随机 token（不只 pid）：host 崩溃留下陈旧 sock 后，另一会话即便复用
// 了同一 pid 也不会撞上同名 pipe——否则 daemon 重扫旧会话目录会连到新会话的终端，
// 串读输出、误注入输入。client 从 sock 文件读全名，无需知道 token 生成规则。
func listenIPC(dir string) (net.Listener, error) {
	var tok [8]byte
	if _, err := rand.Read(tok[:]); err != nil {
		return nil, err
	}
	pipeName := fmt.Sprintf(`\\.\pipe\cxx-pty-%d-%s`, os.Getpid(), hex.EncodeToString(tok[:]))
	ln, err := winio.ListenPipe(pipeName, nil)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "sock"), []byte(pipeName), 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func cleanupIPC(dir string) {
	_ = os.Remove(filepath.Join(dir, "sock"))
}
