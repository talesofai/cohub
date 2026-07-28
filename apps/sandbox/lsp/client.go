package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cohub/apps/sandbox/process"
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type incomingMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type pendingResponse struct {
	result json.RawMessage
	err    error
}

type openedDocument struct {
	version int
	mtimeNS int64
	size    int64
}

type client struct {
	language        Language
	server          string
	root            string
	processID       string
	stdin           io.WriteCloser
	stdout          io.ReadCloser
	stderr          io.ReadCloser
	abort           func() error
	maxMessageBytes int
	logger          *slog.Logger

	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan pendingResponse
	opened  map[string]openedDocument

	diagnostics       map[string][]Diagnostic
	diagnosticVersion map[string]uint64
	diagnosticNotify  chan struct{}

	nextID       atomic.Int64
	closed       chan struct{}
	closeOnce    sync.Once
	lastActivity atomic.Int64
	closeErr     error
}

func newClient(
	ctx context.Context,
	language Language,
	server string,
	root string,
	started *process.ProtocolProcess,
	maxMessageBytes int,
	logger *slog.Logger,
	abort func() error,
	initializationOptions map[string]interface{},
) (*client, error) {
	value := &client{
		language:          language,
		server:            server,
		root:              root,
		processID:         started.ID,
		stdin:             started.Stdin,
		stdout:            started.Stdout,
		stderr:            started.Stderr,
		abort:             abort,
		maxMessageBytes:   maxMessageBytes,
		logger:            logger,
		pending:           make(map[string]chan pendingResponse),
		opened:            make(map[string]openedDocument),
		diagnostics:       make(map[string][]Diagnostic),
		diagnosticVersion: make(map[string]uint64),
		diagnosticNotify:  make(chan struct{}, 1),
		closed:            make(chan struct{}),
	}
	value.touch()
	go value.readLoop()
	go value.drainStderr()
	go func() {
		exit, ok := <-started.Exit
		if !ok {
			return
		}
		code := "unknown"
		if exit.ExitCode != nil {
			code = fmt.Sprintf("%d", *exit.ExitCode)
		}
		value.fail(fmt.Errorf("language server exited: code=%s reason=%s", code, exit.Reason))
	}()

	initializeParams := map[string]interface{}{
		"processId": nil,
		"clientInfo": map[string]string{
			"name":    "Cohub Sandbox",
			"version": "1",
		},
		"rootUri": pathToURI(root),
		"workspaceFolders": []map[string]string{{
			"uri":  pathToURI(root),
			"name": filepathBase(root),
		}},
		"capabilities": map[string]interface{}{
			"workspace": map[string]interface{}{
				"configuration":    true,
				"workspaceFolders": true,
				"applyEdit":        false,
			},
			"textDocument": map[string]interface{}{
				"publishDiagnostics": map[string]interface{}{
					"relatedInformation": true,
				},
				"definition":     map[string]interface{}{},
				"references":     map[string]interface{}{},
				"hover":          map[string]interface{}{},
				"documentSymbol": map[string]interface{}{},
				"synchronization": map[string]interface{}{
					"didSave": true,
				},
			},
		},
	}
	if len(initializationOptions) > 0 {
		initializeParams["initializationOptions"] = initializationOptions
	}
	var initializeResult json.RawMessage
	if err := value.request(ctx, "initialize", initializeParams, &initializeResult); err != nil {
		value.fail(err)
		return nil, fmt.Errorf("initialize language server: %w", err)
	}
	if err := value.notify("initialized", map[string]interface{}{}); err != nil {
		value.fail(err)
		return nil, fmt.Errorf("notify initialized: %w", err)
	}
	return value, nil
}

func (c *client) isAlive() bool {
	select {
	case <-c.closed:
		return false
	default:
		return true
	}
}

func (c *client) touch() {
	c.lastActivity.Store(time.Now().UnixNano())
}

func (c *client) idleFor(now time.Time) time.Duration {
	last := c.lastActivity.Load()
	if last == 0 {
		return 0
	}
	return now.Sub(time.Unix(0, last))
}

func (c *client) request(ctx context.Context, method string, params interface{}, result interface{}) error {
	if !c.isAlive() {
		return c.closedError()
	}
	id := c.nextID.Add(1)
	key := fmt.Sprintf("%d", id)
	responseCh := make(chan pendingResponse, 1)
	c.mu.Lock()
	c.pending[key] = responseCh
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
	}()

	payload, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	if err := c.write(payload); err != nil {
		return err
	}
	c.touch()

	select {
	case response := <-responseCh:
		if response.err != nil {
			return response.err
		}
		if result == nil || len(response.result) == 0 {
			return nil
		}
		if raw, ok := result.(*json.RawMessage); ok {
			*raw = append((*raw)[:0], response.result...)
			return nil
		}
		return json.Unmarshal(response.result, result)
	case <-ctx.Done():
		_ = c.notify("$/cancelRequest", map[string]interface{}{"id": id})
		return ctx.Err()
	case <-c.closed:
		return c.closedError()
	}
}

func (c *client) notify(method string, params interface{}) error {
	payload, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	if err := c.write(payload); err != nil {
		return err
	}
	c.touch()
	return nil
}

func (c *client) write(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return writeMessage(c.stdin, payload)
}

func (c *client) readLoop() {
	reader := bufio.NewReader(c.stdout)
	for {
		payload, err := readMessage(reader, c.maxMessageBytes)
		if err != nil {
			c.fail(err)
			return
		}
		var message incomingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			c.fail(fmt.Errorf("decode LSP message: %w", err))
			return
		}
		if message.Method != "" {
			c.handleServerMessage(message)
			continue
		}
		if len(message.ID) == 0 {
			continue
		}
		key := string(message.ID)
		c.mu.Lock()
		pending := c.pending[key]
		c.mu.Unlock()
		if pending == nil {
			continue
		}
		if message.Error != nil {
			pending <- pendingResponse{err: fmt.Errorf("LSP error %d: %s", message.Error.Code, message.Error.Message)}
		} else {
			pending <- pendingResponse{result: message.Result}
		}
	}
}

func (c *client) handleServerMessage(message incomingMessage) {
	if message.Method == "textDocument/publishDiagnostics" {
		var params struct {
			URI         string       `json:"uri"`
			Diagnostics []Diagnostic `json:"diagnostics"`
		}
		if err := json.Unmarshal(message.Params, &params); err == nil {
			c.mu.Lock()
			c.diagnostics[params.URI] = append([]Diagnostic(nil), params.Diagnostics...)
			c.diagnosticVersion[params.URI]++
			c.mu.Unlock()
			select {
			case c.diagnosticNotify <- struct{}{}:
			default:
			}
		}
		return
	}
	if len(message.ID) == 0 {
		return
	}

	var result interface{}
	var responseError *rpcError
	switch message.Method {
	case "workspace/configuration":
		var params struct {
			Items []interface{} `json:"items"`
		}
		_ = json.Unmarshal(message.Params, &params)
		result = make([]interface{}, len(params.Items))
	case "workspace/applyEdit":
		result = map[string]interface{}{
			"applied":       false,
			"failureReason": "Cohub read-only LSP rejects workspace/applyEdit",
		}
	case "client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create":
		result = nil
	default:
		responseError = &rpcError{Code: -32601, Message: "method not supported by Cohub LSP client"}
	}
	response := map[string]interface{}{"jsonrpc": "2.0", "id": json.RawMessage(message.ID)}
	if responseError != nil {
		response["error"] = responseError
	} else {
		response["result"] = result
	}
	payload, err := json.Marshal(response)
	if err == nil {
		_ = c.write(payload)
	}
}

func (c *client) drainStderr() {
	reader := bufio.NewReader(c.stderr)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			if len(line) > 2_000 {
				line = line[:2_000] + "..."
			}
			c.logger.Debug("lsp:stderr",
				slog.String("language", string(c.language)),
				slog.String("server", c.server),
				slog.String("line", line),
			)
		}
		if err != nil {
			return
		}
	}
}

func (c *client) ensureOpen(path string) (string, uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	if info.IsDir() {
		return "", 0, fmt.Errorf("LSP document path is a directory: %s", path)
	}
	if info.Size() > 2*1024*1024 {
		return "", 0, fmt.Errorf("LSP document exceeds 2 MiB limit: %s", path)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	uri := pathToURI(path)
	c.mu.Lock()
	opened, exists := c.opened[uri]
	diagnosticVersion := c.diagnosticVersion[uri]
	c.mu.Unlock()

	if !exists {
		opened = openedDocument{version: 1, mtimeNS: info.ModTime().UnixNano(), size: info.Size()}
		if err := c.notify("textDocument/didOpen", map[string]interface{}{
			"textDocument": map[string]interface{}{
				"uri":        uri,
				"languageId": languageID(c.language, path),
				"version":    opened.version,
				"text":       string(content),
			},
		}); err != nil {
			return "", 0, err
		}
		c.mu.Lock()
		c.opened[uri] = opened
		c.mu.Unlock()
		return uri, diagnosticVersion + 1, nil
	}

	changed := opened.mtimeNS != info.ModTime().UnixNano() || opened.size != info.Size()
	if changed {
		opened.version++
		opened.mtimeNS = info.ModTime().UnixNano()
		opened.size = info.Size()
		if err := c.notify("textDocument/didChange", map[string]interface{}{
			"textDocument": map[string]interface{}{"uri": uri, "version": opened.version},
			"contentChanges": []map[string]string{{
				"text": string(content),
			}},
		}); err != nil {
			return "", 0, err
		}
		c.mu.Lock()
		c.opened[uri] = opened
		c.mu.Unlock()
	}
	if changed {
		return uri, diagnosticVersion + 1, nil
	}
	return uri, diagnosticVersion, nil
}

func (c *client) waitDiagnostics(ctx context.Context, uri string, minimumVersion uint64) ([]Diagnostic, error) {
	for {
		c.mu.Lock()
		currentVersion := c.diagnosticVersion[uri]
		diagnostics, present := c.diagnostics[uri]
		c.mu.Unlock()
		if present && currentVersion >= minimumVersion {
			// Some servers (notably gopls) publish an initial empty set while
			// package loading is still in progress. Give empty results a bounded
			// grace period so the first useful diagnostics are not lost.
			settleDelay := 100 * time.Millisecond
			if len(diagnostics) == 0 {
				settleDelay = 2 * time.Second
			}
			timer := time.NewTimer(settleDelay)
			select {
			case <-c.diagnosticNotify:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				continue
			case <-timer.C:
				return append([]Diagnostic(nil), diagnostics...), nil
			case <-ctx.Done():
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return append([]Diagnostic(nil), diagnostics...), nil
			}
		}
		select {
		case <-c.diagnosticNotify:
		case <-ctx.Done():
			if present {
				return append([]Diagnostic(nil), diagnostics...), nil
			}
			return nil, ctx.Err()
		case <-c.closed:
			return nil, c.closedError()
		}
	}
}

func (c *client) close(ctx context.Context) {
	if !c.isAlive() {
		return
	}
	_ = c.request(ctx, "shutdown", map[string]interface{}{}, nil)
	_ = c.notify("exit", map[string]interface{}{})
	_ = c.stdin.Close()
	select {
	case <-c.closed:
	case <-ctx.Done():
		_ = c.abort()
	}
}

func (c *client) fail(err error) {
	c.closeOnce.Do(func() {
		if err == nil {
			err = errors.New("language server closed")
		}
		c.mu.Lock()
		c.closeErr = err
		pending := c.pending
		c.pending = make(map[string]chan pendingResponse)
		c.mu.Unlock()
		for _, responseCh := range pending {
			select {
			case responseCh <- pendingResponse{err: err}:
			default:
			}
		}
		close(c.closed)
	})
}

func (c *client) closedError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closeErr != nil {
		return c.closeErr
	}
	return errors.New("language server is closed")
}

func filepathBase(path string) string {
	for len(path) > 1 && (path[len(path)-1] == '/' || path[len(path)-1] == '\\') {
		path = path[:len(path)-1]
	}
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == '/' || path[index] == '\\' {
			return path[index+1:]
		}
	}
	return path
}

func languageID(language Language, path string) string {
	if language == LanguageGo {
		return "go"
	}
	if language == LanguagePython {
		return "python"
	}
	switch filepathExt(path) {
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "javascriptreact"
	case ".tsx":
		return "typescriptreact"
	default:
		return "typescript"
	}
}

func filepathExt(path string) string {
	for index := len(path) - 1; index >= 0; index-- {
		if path[index] == '.' {
			return path[index:]
		}
		if path[index] == '/' || path[index] == '\\' {
			break
		}
	}
	return ""
}
