package lsp

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const defaultMaxMessageBytes = 4 * 1024 * 1024

func readMessage(reader *bufio.Reader, maxMessageBytes int) ([]byte, error) {
	if maxMessageBytes <= 0 {
		maxMessageBytes = defaultMaxMessageBytes
	}

	contentLength := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("lsp framing: invalid header %q", line)
		}
		if !strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			continue
		}
		if contentLength >= 0 {
			return nil, fmt.Errorf("lsp framing: duplicate Content-Length")
		}
		parsed, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || parsed < 0 {
			return nil, fmt.Errorf("lsp framing: invalid Content-Length %q", value)
		}
		if parsed > maxMessageBytes {
			return nil, fmt.Errorf("lsp framing: message size %d exceeds limit %d", parsed, maxMessageBytes)
		}
		contentLength = parsed
	}
	if contentLength < 0 {
		return nil, fmt.Errorf("lsp framing: Content-Length is required")
	}

	payload := make([]byte, contentLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, fmt.Errorf("lsp framing: read payload: %w", err)
	}
	return payload, nil
}

func writeMessage(writer io.Writer, payload []byte) error {
	var framed bytes.Buffer
	if _, err := fmt.Fprintf(&framed, "Content-Length: %d\r\n\r\n", len(payload)); err != nil {
		return err
	}
	if _, err := framed.Write(payload); err != nil {
		return err
	}
	_, err := writer.Write(framed.Bytes())
	return err
}
