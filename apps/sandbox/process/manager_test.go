package process

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartProtocolKeepsStdinOpen(t *testing.T) {
	manager := NewManager(slog.Default())
	started, err := manager.StartProtocol("owner-1", "cat", nil, t.TempDir(), 5, nil)
	if err != nil {
		t.Fatalf("start protocol: %v", err)
	}
	if _, err := started.Stdin.Write([]byte("hello lsp\n")); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	if err := started.Stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}
	output, err := io.ReadAll(started.Stdout)
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	exit := <-started.Exit
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Fatalf("exit = %#v", exit)
	}
	if string(output) != "hello lsp\n" {
		t.Fatalf("stdout = %q", output)
	}
}

func TestStartProtocolAllowsTrustedStateEnvOverride(t *testing.T) {
	manager := NewManager(slog.Default())
	stateHome := filepath.Join(t.TempDir(), "state-home")
	if err := os.MkdirAll(stateHome, 0o700); err != nil {
		t.Fatal(err)
	}
	started, err := manager.StartProtocol(
		"owner-1",
		"sh",
		[]string{"-c", `printf %s "$HOME"`},
		t.TempDir(),
		5,
		map[string]string{"HOME": stateHome},
	)
	if err != nil {
		t.Fatalf("start protocol: %v", err)
	}
	if err := started.Stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}
	output, err := io.ReadAll(started.Stdout)
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	exit := <-started.Exit
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		stderr, _ := io.ReadAll(started.Stderr)
		t.Fatalf("exit = %#v stderr=%q", exit, stderr)
	}
	if strings.TrimSpace(string(output)) != stateHome {
		t.Fatalf("HOME = %q, want %q", output, stateHome)
	}
}
