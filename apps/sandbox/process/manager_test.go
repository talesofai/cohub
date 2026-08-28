package process

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("stream failed") }

func (failingReader) Close() error { return nil }

func TestStreamBothReportsReadErrors(t *testing.T) {
	stdout, stderr := StreamBoth(failingReader{}, failingReader{}, func(string, Stream) {})
	if err := WaitStreams(stdout, stderr); err == nil || !strings.Contains(err.Error(), "stream failed") {
		t.Fatalf("WaitStreams error = %v, want stream read error", err)
	}
}

func TestStartWithOptionsBoundsInheritedOutputDescriptors(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	m := NewManager(slog.Default())
	_, stdout, stderr, exitCh, err := m.StartWithOptions("test", StartOptions{
		Command: fmt.Sprintf("sleep 60 & echo $! > %q", pidFile),
		CWD:     t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = io.Copy(io.Discard, stdout) }()
	go func() { _, _ = io.Copy(io.Discard, stderr) }()

	select {
	case info := <-exitCh:
		if !info.OutputTruncated {
			t.Fatal("expected inherited output descriptor to be marked truncated")
		}
	case <-time.After(processWaitDelay + time.Second):
		t.Fatal("process did not complete within WaitDelay")
	}

	data, readErr := os.ReadFile(pidFile)
	if readErr == nil {
		if pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data))); parseErr == nil {
			if child, findErr := os.FindProcess(pid); findErr == nil {
				_ = child.Kill()
			}
		}
	}
}
