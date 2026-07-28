package lsp

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/process"
)

func TestManagerReadOnlyQueriesAndMountedWorkspaceIsolation(t *testing.T) {
	manager, permissions, workspace, mounted := newFakeManager(t)
	defer manager.Close()

	sourcePath := filepath.Join(workspace, "main.ts")
	if err := os.WriteFile(sourcePath, []byte("const answer = 42;\nanswer;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mountedPath := filepath.Join(mounted, "shared.ts")
	if err := os.WriteFile(mountedPath, []byte("export const shared = true;\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	status, err := manager.Query("owner-1", permissions, Query{Action: ActionStatus})
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Available || len(status.Status) != 3 || !status.Status[0].Available {
		t.Fatalf("status = %#v", status)
	}

	diagnostics, err := manager.Query("owner-1", permissions, Query{
		Action: ActionDiagnostics,
		Path:   sourcePath,
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("diagnostics: %v", err)
	}
	if len(diagnostics.Diagnostics) != 1 || diagnostics.Diagnostics[0].Message != "fake diagnostic" {
		t.Fatalf("diagnostics = %#v", diagnostics.Diagnostics)
	}

	definition, err := manager.Query("owner-1", permissions, Query{
		Action:    ActionDefinition,
		Path:      sourcePath,
		Line:      1,
		Character: 2,
	})
	if err != nil {
		t.Fatalf("definition: %v", err)
	}
	if len(definition.Locations) != 1 || definition.Locations[0].Path != sourcePath {
		t.Fatalf("definition = %#v", definition.Locations)
	}

	references, err := manager.Query("owner-1", permissions, Query{
		Action:    ActionReferences,
		Path:      sourcePath,
		Line:      1,
		Character: 2,
		Limit:     1,
	})
	if err != nil {
		t.Fatalf("references: %v", err)
	}
	if len(references.Locations) != 1 || references.Total != 2 || !references.Truncated {
		t.Fatalf("references = %#v", references)
	}

	hover, err := manager.Query("owner-1", permissions, Query{
		Action:    ActionHover,
		Path:      sourcePath,
		Line:      1,
		Character: 2,
	})
	if err != nil {
		t.Fatalf("hover: %v", err)
	}
	if hover.Hover == nil || hover.Hover.Text != "const answer: 42" {
		t.Fatalf("hover = %#v", hover.Hover)
	}

	symbols, err := manager.Query("owner-1", permissions, Query{
		Action:      ActionSymbols,
		Path:        sourcePath,
		SymbolScope: SymbolScopeDocument,
	})
	if err != nil {
		t.Fatalf("symbols: %v", err)
	}
	if len(symbols.Symbols) != 1 || symbols.Symbols[0].Name != "answer" {
		t.Fatalf("symbols = %#v", symbols.Symbols)
	}

	mountedResult, err := manager.Query("owner-1", permissions, Query{
		Action: ActionDefinition,
		Path:   mountedPath,
	})
	if err != nil {
		t.Fatalf("mounted definition: %v", err)
	}
	if len(mountedResult.Locations) != 1 || mountedResult.Locations[0].Path != mountedPath {
		t.Fatalf("mounted definition = %#v", mountedResult.Locations)
	}

	if !permissions.CanRead(mountedPath) {
		t.Fatal("mounted fixture must remain readable")
	}
}

func TestManagerRejectsOutsideReadPolicy(t *testing.T) {
	manager, permissions, _, _ := newFakeManager(t)
	defer manager.Close()

	outside := filepath.Join(t.TempDir(), "secret.ts")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := manager.Query("owner-1", permissions, Query{Action: ActionHover, Path: outside})
	var lspError *Error
	if !errorsAs(err, &lspError) || lspError.Code != ErrorAccess {
		t.Fatalf("error = %v, want ACCESS_DENIED", err)
	}
}

func TestReadPolicyRejectsSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.ts")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(workspace, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}

	policy := NewReadPolicy(workspace)
	if policy.CanRead(filepath.Join(link, "secret.ts")) {
		t.Fatal("read policy allowed a symlink escape from the Space")
	}
}

func TestManagerClosesIdleClients(t *testing.T) {
	manager, permissions, workspace, _ := newFakeManager(t)
	defer manager.Close()
	path := filepath.Join(workspace, "main.ts")
	if err := os.WriteFile(path, []byte("const x = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Query("owner-1", permissions, Query{Action: ActionHover, Path: path}); err != nil {
		t.Fatalf("query: %v", err)
	}
	if closed := manager.CloseIdle(time.Now().Add(time.Hour)); closed != 1 {
		t.Fatalf("closed = %d, want 1", closed)
	}
}

func TestManagerStatusReportsMissingServerWithoutStartingShell(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManagerWithConfig(ManagerConfig{
		Servers: map[Language]ServerConfig{
			LanguageTypeScript: {
				Language:   LanguageTypeScript,
				Executable: filepath.Join(t.TempDir(), "missing-typescript-language-server"),
			},
		},
		StateRoot: filepath.Join(t.TempDir(), "state"),
	}, process.NewManager(logger), logger)
	defer manager.Close()

	statuses := manager.Status("owner-1", LanguageTypeScript)
	if len(statuses) != 1 || statuses[0].Available || statuses[0].Error == "" {
		t.Fatalf("statuses = %#v, want one unavailable server with actionable error", statuses)
	}
}

func newFakeManager(t *testing.T) (*Manager, ReadPolicy, string, string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	mounted := filepath.Join(root, "mounted")
	for _, dir := range []string{workspace, mounted} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	processManager := process.NewManager(logger)
	server := ServerConfig{
		Language:   LanguageTypeScript,
		Executable: os.Args[0],
		Args:       []string{"-test.run=TestLSPHelperProcess"},
		Env:        map[string]string{"COHUB_LSP_HELPER": "1"},
	}
	goServer := server
	goServer.Language = LanguageGo
	pythonServer := server
	pythonServer.Language = LanguagePython
	manager := NewManagerWithConfig(ManagerConfig{
		Servers: map[Language]ServerConfig{
			LanguageTypeScript: server,
			LanguageGo:         goServer,
			LanguagePython:     pythonServer,
		},
		RequestTimeout:  2 * time.Second,
		IdleTimeout:     10 * time.Minute,
		MaxMessageBytes: 64 * 1024,
		StateRoot:       filepath.Join(root, "state"),
	}, processManager, logger)
	permissions := NewReadPolicy(workspace, mounted)
	return manager, permissions, workspace, mounted
}

func TestDetectLanguageAndLanguageIDSupportPython(t *testing.T) {
	for _, path := range []string{"main.py", "types.pyi"} {
		language, err := detectLanguage(path, "")
		if err != nil {
			t.Fatalf("detectLanguage(%q): %v", path, err)
		}
		if language != LanguagePython {
			t.Fatalf("detectLanguage(%q) = %q, want %q", path, language, LanguagePython)
		}
		if got := languageID(language, path); got != "python" {
			t.Fatalf("languageID(%q) = %q, want python", path, got)
		}
	}
}

func TestNormalizeSymbolsAppliesLimitAcrossNestedBranches(t *testing.T) {
	raw := json.RawMessage(`[
		{"name":"first","kind":5,"children":[
			{"name":"first-child","kind":6},
			{"name":"second-child","kind":6}
		]},
		{"name":"second","kind":5}
	]`)
	symbols, total, truncated, err := normalizeSymbols(raw, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 || !truncated {
		t.Fatalf("total = %d, truncated = %v", total, truncated)
	}
	if countSymbols(symbols) != 2 || len(symbols) != 1 || len(symbols[0].Children) != 1 {
		t.Fatalf("symbols = %#v", symbols)
	}
}

func TestLSPHelperProcess(t *testing.T) {
	if os.Getenv("COHUB_LSP_HELPER") != "1" {
		return
	}
	runFakeLSPServer(os.Stdin, os.Stdout)
	os.Exit(0)
}

func runFakeLSPServer(input io.Reader, output io.Writer) {
	reader := bufio.NewReader(input)
	writer := bufio.NewWriter(output)
	write := func(value interface{}) {
		payload, _ := json.Marshal(value)
		_ = writeMessage(writer, payload)
		_ = writer.Flush()
	}
	applyEditPending := false
	currentURI := ""
	for {
		payload, err := readMessage(reader, 64*1024)
		if err != nil {
			return
		}
		var message incomingMessage
		if json.Unmarshal(payload, &message) != nil {
			os.Exit(2)
		}
		if message.Method == "" {
			if applyEditPending && string(message.ID) == "900" {
				var result struct {
					Applied bool `json:"applied"`
				}
				if json.Unmarshal(message.Result, &result) != nil || result.Applied {
					os.Exit(3)
				}
				applyEditPending = false
			}
			continue
		}
		id := message.ID
		switch message.Method {
		case "initialize":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": map[string]interface{}{
				"capabilities": map[string]interface{}{
					"textDocumentSync":       1,
					"definitionProvider":     true,
					"referencesProvider":     true,
					"hoverProvider":          true,
					"documentSymbolProvider": true,
				},
			}})
		case "initialized":
			applyEditPending = true
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      900,
				"method":  "workspace/applyEdit",
				"params":  map[string]interface{}{"edit": map[string]interface{}{}},
			})
		case "textDocument/didOpen", "textDocument/didChange":
			var params struct {
				TextDocument struct {
					URI string `json:"uri"`
				} `json:"textDocument"`
			}
			_ = json.Unmarshal(message.Params, &params)
			currentURI = params.TextDocument.URI
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"method":  "textDocument/publishDiagnostics",
				"params": map[string]interface{}{
					"uri": currentURI,
					"diagnostics": []map[string]interface{}{{
						"range":    fakeRange(0, 0, 0, 5),
						"severity": 2,
						"source":   "fake-lsp",
						"message":  "fake diagnostic",
					}},
				},
			})
		case "textDocument/definition":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": []map[string]interface{}{{
				"uri": currentURI, "range": fakeRange(0, 6, 0, 12),
			}}})
		case "textDocument/references":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": []map[string]interface{}{
				{"uri": currentURI, "range": fakeRange(0, 6, 0, 12)},
				{"uri": currentURI, "range": fakeRange(1, 0, 1, 6)},
			}})
		case "textDocument/hover":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": map[string]interface{}{
				"contents": map[string]string{"kind": "markdown", "value": "const answer: 42"},
			}})
		case "textDocument/documentSymbol":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": []map[string]interface{}{{
				"name": "answer", "kind": 13, "range": fakeRange(0, 0, 0, 17), "selectionRange": fakeRange(0, 6, 0, 12),
			}}})
		case "workspace/symbol":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": []map[string]interface{}{{
				"name": "answer", "kind": 13, "location": map[string]interface{}{"uri": currentURI, "range": fakeRange(0, 0, 0, 17)},
			}}})
		case "shutdown":
			write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": nil})
		case "exit":
			return
		default:
			if len(id) > 0 {
				write(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": nil})
			}
		}
	}
}

func fakeRange(startLine, startCharacter, endLine, endCharacter int) map[string]interface{} {
	return map[string]interface{}{
		"start": map[string]int{"line": startLine, "character": startCharacter},
		"end":   map[string]int{"line": endLine, "character": endCharacter},
	}
}

func errorsAs(err error, target interface{}) bool {
	return errors.As(err, target)
}
