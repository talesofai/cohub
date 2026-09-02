package process

import (
	"errors"
	"io"
)

// Stream identifies one of a process's output streams.
type Stream int

const (
	StreamStdout Stream = iota
	StreamStderr
)

// StreamResult reports completion and any non-EOF read error for one output stream.
type StreamResult struct {
	Done <-chan struct{}
	Err  <-chan error
}

// StreamBoth drains stdout and stderr concurrently. The callback is invoked
// synchronously by the readers, while read errors remain available to the
// caller through WaitStreams.
func StreamBoth(stdout io.Reader, stderr io.Reader, onChunk func(chunk string, stream Stream)) (StreamResult, StreamResult) {
	stdoutDone := make(chan struct{})
	stdoutErr := make(chan error, 1)
	stderrDone := make(chan struct{})
	stderrErr := make(chan error, 1)
	go func() {
		defer close(stdoutDone)
		stdoutErr <- StreamChunks(stdout, func(chunk string) {
			onChunk(chunk, StreamStdout)
		})
	}()
	go func() {
		defer close(stderrDone)
		stderrErr <- StreamChunks(stderr, func(chunk string) {
			onChunk(chunk, StreamStderr)
		})
	}()
	return StreamResult{Done: stdoutDone, Err: stdoutErr}, StreamResult{Done: stderrDone, Err: stderrErr}
}

// WaitStreams waits for both streams and returns any non-EOF read errors.
func WaitStreams(stdout, stderr StreamResult) error {
	<-stdout.Done
	<-stderr.Done
	return errors.Join(<-stdout.Err, <-stderr.Err)
}

// StreamChunks forwards chunks from reader until EOF.
func StreamChunks(reader io.Reader, onChunk func(string)) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			onChunk(string(buf[:n]))
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
