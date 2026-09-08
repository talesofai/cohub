//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package locald

import (
	"os/exec"
	"syscall"
)

func configureProviderProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
}

func forceKillProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	// Providers may launch children that inherit the stdio pipes. Kill the
	// process group so those children cannot keep the relay blocked after the
	// graceful termination window expires.
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
