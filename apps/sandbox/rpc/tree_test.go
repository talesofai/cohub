package rpc

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
)

func newTreeDispatcher(t *testing.T, root string) *Dispatcher {
	t.Helper()
	cfg := env.Config{WorkspaceDir: root, Fence: true}
	dispatcher := NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default())
	t.Cleanup(dispatcher.Close)
	return dispatcher
}

func treeRequest(t *testing.T, params fsTreeParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-1"},
		Method:               "fs.tree",
		Params:               raw,
	}
}

func runTree(t *testing.T, d *Dispatcher, params fsTreeParams) map[string]interface{} {
	t.Helper()
	result := d.handleFSTree(treeRequest(t, params))
	m, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T (%v)", result, result)
	}
	return m
}

func treeEntries(t *testing.T, m map[string]interface{}) []fsTreeEntry {
	t.Helper()
	raw, _ := json.Marshal(m["entries"])
	var entries []fsTreeEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("decode entries: %v", err)
	}
	return entries
}

func setupTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks: %v", err)
	}
	mustWrite := func(rel, content string) {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	mustWrite("README.md", "hi")
	mustWrite("src/index.ts", "code")
	mustWrite("src/deep/util.ts", "deep")
	mustWrite("node_modules/pkg/index.js", "dep")
	mustWrite(".gitignore", "node_modules\n")
	if err := os.MkdirAll(filepath.Join(root, ".git", "objects"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	return root
}

func TestFSTreeDepthOne(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 1}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	// Depth 1 lists direct children only.
	if !names["README.md"] || !names["src"] || !names[".gitignore"] {
		t.Fatalf("missing expected top-level entries: %v", names)
	}
	if names["src/index.ts"] {
		t.Fatalf("depth 1 should not recurse into src")
	}
	// .git and gitignored node_modules must be hidden.
	if names[".git"] || names["node_modules"] {
		t.Fatalf("expected .git and node_modules to be hidden: %v", names)
	}
}

func TestFSTreeDepthRecurse(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 3}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	if !names["src/index.ts"] || !names["src/deep/util.ts"] {
		t.Fatalf("expected nested files at depth 3: %v", names)
	}
	// node_modules subtree stays hidden even when recursing.
	for p := range names {
		if p == "node_modules" || p == "node_modules/pkg" {
			t.Fatalf("node_modules subtree should be pruned: %v", names)
		}
	}
}

func TestFSTreeNoGitignore(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	respect := false
	entries := treeEntries(t, runTree(t, d, fsTreeParams{Path: ".", Depth: 1, RespectGitignore: &respect}))

	names := map[string]bool{}
	for _, e := range entries {
		names[e.Path] = true
	}
	// With gitignore off, node_modules is visible; .git is always hidden.
	if !names["node_modules"] {
		t.Fatalf("expected node_modules visible without gitignore: %v", names)
	}
	if names[".git"] {
		t.Fatalf(".git must always be hidden: %v", names)
	}
}

func TestFSTreeTruncated(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	m := runTree(t, d, fsTreeParams{Path: ".", Depth: 3, Limit: 2})
	entries := treeEntries(t, m)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries under limit, got %d", len(entries))
	}
	if truncated, _ := m["truncated"].(bool); !truncated {
		t.Fatalf("expected truncated=true when limit reached")
	}
}

func writeRequest(t *testing.T, params fsWriteParams) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal write params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-w"},
		Method:               "fs.write",
		Params:               raw,
	}
}

func TestFSWriteExclusive(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)

	// First exclusive create succeeds.
	res := d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "new.txt", Content: "one", Exclusive: true}))
	if _, ok := res.(map[string]interface{}); !ok {
		t.Fatalf("expected first exclusive create to succeed, got %T (%v)", res, res)
	}

	// Second exclusive create on the same path must fail ALREADY_EXISTS and not
	// clobber the original content.
	res2 := d.handleFSWrite(writeRequest(t, fsWriteParams{Path: "new.txt", Content: "two", Exclusive: true}))
	failed, ok := res2.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected second exclusive create to fail, got %T", res2)
	}
	if failed.Error.Code != "ALREADY_EXISTS" {
		t.Fatalf("expected ALREADY_EXISTS, got %s", failed.Error.Code)
	}
	got, _ := os.ReadFile(filepath.Join(root, "new.txt"))
	if string(got) != "one" {
		t.Fatalf("exclusive create clobbered content: got %q", string(got))
	}
}

func TestFSTreeRootUnreadable(t *testing.T) {
	root := setupTree(t)
	d := newTreeDispatcher(t, root)
	// A non-existent root surfaces NOT_FOUND (stat) rather than an empty tree.
	res := d.handleFSTree(treeRequest(t, fsTreeParams{Path: "does-not-exist", Depth: 1}))
	if _, ok := res.(protocol.RPCFailed); !ok {
		t.Fatalf("expected failure for missing root, got %T", res)
	}
}
