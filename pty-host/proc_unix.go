//go:build !windows

package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/creack/pty"
)

type ptyProc interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Pid() int
	Terminate(force bool) error
	Wait() (code int, signal string)
}

type unixProc struct {
	cmd *exec.Cmd
	f   *os.File
}

func startProc(spec *spawnSpec) (ptyProc, error) {
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = buildEnv(spec.Env)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(spec.Cols),
		Rows: uint16(spec.Rows),
	})
	if err != nil {
		return nil, err
	}
	return &unixProc{cmd: cmd, f: f}, nil
}

func buildEnv(env map[string]string) []string {
	if len(env) == 0 {
		return os.Environ()
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func (p *unixProc) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixProc) Write(b []byte) (int, error) { return p.f.Write(b) }

func (p *unixProc) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func (p *unixProc) Pid() int { return p.cmd.Process.Pid }

// Terminate：pty.Start 使子进程成为新 session leader，负 pid 带走其进程组。
func (p *unixProc) Terminate(force bool) error {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, sig); err != nil {
		return p.cmd.Process.Signal(sig)
	}
	return nil
}

func (p *unixProc) Wait() (int, string) {
	err := p.cmd.Wait()
	_ = err
	ws := p.cmd.ProcessState
	if ws == nil {
		return -1, ""
	}
	if st, ok := ws.Sys().(syscall.WaitStatus); ok && st.Signaled() {
		return -1, st.Signal().String()
	}
	return ws.ExitCode(), ""
}

func eofBytes() []byte { return []byte{0x04} }

// listenIPC：unix socket，路径写死在 session 目录内（0700 目录即信任边界）。
func listenIPC(dir string) (net.Listener, error) {
	sock := filepath.Join(dir, "sock")
	_ = os.Remove(sock)
	return net.Listen("unix", sock)
}

func cleanupIPC(dir string) {
	_ = os.Remove(filepath.Join(dir, "sock"))
}
