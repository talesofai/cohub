//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package locald

import (
	"os/exec"
	"syscall"
)

func configureAcpProviderProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateAcpProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
}
