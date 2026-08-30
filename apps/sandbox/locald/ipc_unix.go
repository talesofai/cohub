//go:build !windows

package locald

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"time"
)

func listenEndpoint(path string) (net.Listener, error) {
	if path == "" {
		return nil, errors.New("locald IPC path is required")
	}
	if info, err := os.Stat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("locald IPC path exists and is not a socket: %s", path)
		}
		probe, probeErr := net.DialTimeout("unix", path, 150*time.Millisecond)
		if probeErr == nil {
			_ = probe.Close()
			return nil, fmt.Errorf("locald is already running at %s", path)
		}
		if removeErr := os.Remove(path); removeErr != nil {
			return nil, fmt.Errorf("remove stale locald socket: %w", removeErr)
		}
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("secure locald socket: %w", err)
	}
	return listener, nil
}

func dialEndpoint(ctx context.Context, path string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", path)
}

func closeEndpoint(path string) { _ = os.Remove(path) }
