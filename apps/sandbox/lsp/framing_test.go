package lsp

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestReadMessageAcceptsCaseInsensitiveHeaders(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("content-length: 7\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{\"a\":1}"))
	payload, err := readMessage(reader, 1024)
	if err != nil {
		t.Fatalf("readMessage: %v", err)
	}
	if string(payload) != `{"a":1}` {
		t.Fatalf("payload = %q", string(payload))
	}
}

func TestReadMessageRejectsOversizedPayload(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("Content-Length: 8\r\n\r\n12345678"))
	if _, err := readMessage(reader, 7); err == nil || !strings.Contains(err.Error(), "exceeds limit") {
		t.Fatalf("error = %v, want size limit error", err)
	}
}

func TestReadMessageRejectsMalformedHeaders(t *testing.T) {
	for _, input := range []string{
		"Content-Length nope\r\n\r\n",
		"X-Test: true\r\n\r\n",
		"Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
	} {
		if _, err := readMessage(bufio.NewReader(strings.NewReader(input)), 1024); err == nil {
			t.Fatalf("input %q unexpectedly succeeded", input)
		}
	}
}

func TestWriteMessageRoundTrip(t *testing.T) {
	var output bytes.Buffer
	want := []byte(`{"jsonrpc":"2.0"}`)
	if err := writeMessage(&output, want); err != nil {
		t.Fatalf("writeMessage: %v", err)
	}
	got, err := readMessage(bufio.NewReader(&output), 1024)
	if err != nil {
		t.Fatalf("readMessage: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReadMessageHandlesFragmentedTransport(t *testing.T) {
	input := &fragmentReader{
		chunks: [][]byte{
			[]byte("Content-"),
			[]byte("Length: 7\r\n"),
			[]byte("\r\n{\""),
			[]byte("a\":1}"),
		},
	}
	payload, err := readMessage(bufio.NewReader(input), 1024)
	if err != nil {
		t.Fatalf("readMessage: %v", err)
	}
	if string(payload) != `{"a":1}` {
		t.Fatalf("payload = %q", string(payload))
	}
}

func TestReadMessagePreservesCoalescedFrames(t *testing.T) {
	var input bytes.Buffer
	for _, payload := range [][]byte{[]byte(`{"id":1}`), []byte(`{"id":2}`)} {
		if err := writeMessage(&input, payload); err != nil {
			t.Fatal(err)
		}
	}
	reader := bufio.NewReader(&input)
	for index, want := range []string{`{"id":1}`, `{"id":2}`} {
		got, err := readMessage(reader, 1024)
		if err != nil {
			t.Fatalf("frame %d: %v", index, err)
		}
		if string(got) != want {
			t.Fatalf("frame %d = %q, want %q", index, got, want)
		}
	}
}

func TestReadMessageRejectsTruncatedPayload(t *testing.T) {
	_, err := readMessage(bufio.NewReader(strings.NewReader("Content-Length: 8\r\n\r\nshort")), 1024)
	if err == nil || !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("error = %v, want unexpected EOF", err)
	}
}

type fragmentReader struct {
	chunks [][]byte
}

func (r *fragmentReader) Read(buffer []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := r.chunks[0]
	r.chunks = r.chunks[1:]
	return copy(buffer, chunk), nil
}
