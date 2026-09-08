//go:build windows

package locald

import "os/exec"

func configureProviderProcess(cmd *exec.Cmd) {}

func terminateProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

func forceKillProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
