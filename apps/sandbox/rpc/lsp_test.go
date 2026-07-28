package rpc

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/lsp"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
)

func lspRequest(t *testing.T, params lspQueryParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal LSP params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "lsp-req-1"},
		Method:               "lsp.query",
		Params:               raw,
	}
}

func TestLSPQueryRejectsPathOutsideCurrentSpace(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.ts")
	if err := os.WriteFile(outside, []byte("export const secret = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := env.Config{WorkspaceDir: workspace}
	dispatcher := NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default())
	t.Cleanup(dispatcher.Close)

	result := dispatcher.handleLSPQuery(lspRequest(t, lspQueryParams{
		Action: "hover",
		Path:   outside,
	}), "owner-1")
	failed, ok := result.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("result = %T, want RPCFailed", result)
	}
	if failed.Error.Code != "ACCESS_DENIED" {
		t.Fatalf("error code = %q, want ACCESS_DENIED", failed.Error.Code)
	}
}

func TestLSPResultPathUsesVirtualWorkspaceForLocalSandbox(t *testing.T) {
	workspace := t.TempDir()
	dispatcher := NewDispatcher(
		env.Config{WorkspaceDir: workspace, Fence: true},
		process.NewManager(slog.Default()),
		slog.Default(),
	)
	t.Cleanup(dispatcher.Close)
	path := filepath.Join(workspace, "src", "main.ts")
	if got := dispatcher.toSandboxVisiblePath(path); got != "/workspace/src/main.ts" {
		t.Fatalf("visible path = %q", got)
	}
}

func TestLSPResultDropsOutsideLocationsAndRecounts(t *testing.T) {
	workspace := t.TempDir()
	dispatcher := NewDispatcher(
		env.Config{WorkspaceDir: workspace, Fence: true},
		process.NewManager(slog.Default()),
		slog.Default(),
	)
	t.Cleanup(dispatcher.Close)
	inside := filepath.Join(workspace, "main.ts")
	if err := os.WriteFile(inside, []byte("export const inside = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.ts")
	if err := os.WriteFile(outside, []byte("export const outside = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := lsp.QueryResult{
		Action:   lsp.ActionReferences,
		Returned: 2,
		Locations: []lsp.Location{
			{Path: inside},
			{Path: outside},
		},
	}
	dispatcher.sanitizeLSPResult(&result, lsp.NewReadPolicy(workspace))
	if result.Returned != 1 || len(result.Locations) != 1 {
		t.Fatalf("result = %#v", result)
	}
	if result.Locations[0].Path != "/workspace/main.ts" {
		t.Fatalf("path = %q", result.Locations[0].Path)
	}
}
