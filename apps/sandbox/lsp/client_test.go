package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestClientRequestTimeoutSendsCancellation(t *testing.T) {
	reader, writer := io.Pipe()
	value := &client{
		stdin:   writer,
		pending: make(map[string]chan pendingResponse),
		closed:  make(chan struct{}),
	}
	observed := make(chan incomingMessage, 2)
	go func() {
		framed := bufio.NewReader(reader)
		for index := 0; index < 2; index++ {
			payload, err := readMessage(framed, 4096)
			if err != nil {
				return
			}
			var message incomingMessage
			if json.Unmarshal(payload, &message) == nil {
				observed <- message
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := value.request(ctx, "textDocument/hover", map[string]interface{}{}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("request error = %v, want deadline exceeded", err)
	}

	request := <-observed
	cancellation := <-observed
	if request.Method != "textDocument/hover" {
		t.Fatalf("request method = %q", request.Method)
	}
	if cancellation.Method != "$/cancelRequest" {
		t.Fatalf("cancellation method = %q", cancellation.Method)
	}
	var params struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(cancellation.Params, &params); err != nil {
		t.Fatal(err)
	}
	if params.ID != 1 {
		t.Fatalf("cancelled id = %d, want 1", params.ID)
	}
	_ = reader.Close()
}

func TestClientFailureUnblocksPendingRequest(t *testing.T) {
	reader, writer := io.Pipe()
	value := &client{
		stdin:   writer,
		pending: make(map[string]chan pendingResponse),
		closed:  make(chan struct{}),
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	go func() {
		framed := bufio.NewReader(reader)
		_, _ = readMessage(framed, 4096)
		value.fail(io.ErrUnexpectedEOF)
	}()

	err := value.request(context.Background(), "textDocument/definition", map[string]interface{}{}, nil)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("request error = %v, want unexpected EOF", err)
	}
}

func TestWaitDiagnosticsIgnoresInitialEmptyPublish(t *testing.T) {
	value := &client{
		diagnostics:       map[string][]Diagnostic{"file:///main.go": {}},
		diagnosticVersion: map[string]uint64{"file:///main.go": 1},
		diagnosticNotify:  make(chan struct{}, 1),
	}
	go func() {
		time.Sleep(25 * time.Millisecond)
		value.mu.Lock()
		value.diagnostics["file:///main.go"] = []Diagnostic{{Message: "syntax error"}}
		value.diagnosticVersion["file:///main.go"] = 2
		value.mu.Unlock()
		value.diagnosticNotify <- struct{}{}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	diagnostics, err := value.waitDiagnostics(ctx, "file:///main.go", 1)
	if err != nil {
		t.Fatalf("wait diagnostics: %v", err)
	}
	if len(diagnostics) != 1 || diagnostics[0].Message != "syntax error" {
		t.Fatalf("diagnostics = %#v", diagnostics)
	}
}
