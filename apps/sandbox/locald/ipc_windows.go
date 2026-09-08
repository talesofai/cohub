//go:build windows

package locald

import (
	"context"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

func listenEndpoint(path string) (net.Listener, error) {
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;OW)",
		MessageMode:        false,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
}

func dialEndpoint(ctx context.Context, path string) (net.Conn, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(10 * time.Second)
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, context.DeadlineExceeded
	}
	return winio.DialPipe(path, &remaining)
}

func closeEndpoint(path string) {}
