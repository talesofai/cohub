//go:build windows

package locald

import "os/exec"

func configureAcpProviderProcess(cmd *exec.Cmd) {}

func terminateAcpProviderProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
