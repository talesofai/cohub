package rpc

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
	"github.com/cohub/apps/sandbox/protocol"
)

// collectRouter captures the async rpc.event / rpc.completed / rpc.failed
// messages that process.start delivers via the identity router, so tests can
// assert on the eventual outcome of an argv command.
type collectRouter struct {
	mu        sync.Mutex
	stderr    string
	exitCode  *int
	completed bool
	done      chan struct{}
}

func newCollectRouter() *collectRouter {
	return &collectRouter{done: make(chan struct{})}
}

func (r *collectRouter) SendToIdentity(_ string, v interface{}) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch msg := v.(type) {
	case protocol.RPCEvent:
		if msg.Event.Type == "stderr" {
			r.stderr += msg.Event.Chunk
		}
		if msg.Event.Type == "exit" {
			r.exitCode = msg.Event.ExitCode
		}
	case protocol.RPCCompleted:
		r.completed = true
		close(r.done)
	}
	return nil
}

func (r *collectRouter) waitExitCode(t *testing.T) int {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for process completion")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.exitCode == nil {
		t.Fatal("no exit code reported")
	}
	return *r.exitCode
}

func newProcessDispatcher(t *testing.T, root string) (*Dispatcher, *collectRouter) {
	t.Helper()
	cfg := env.Config{WorkspaceDir: root, Fence: true}
	d := NewDispatcher(cfg, process.NewManager(slog.Default()), slog.Default())
	t.Cleanup(d.Close)
	router := newCollectRouter()
	d.SetRouter(router)
	return d, router
}

func argvRequest(t *testing.T, argv []string) protocol.RPCRequest {
	t.Helper()
	raw, err := json.Marshal(processStartParams{Argv: argv})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-1"},
		Method:               "process.start",
		Params:               raw,
	}
}

// runArgv mirrors what the API's remote backend does: fire process.start with
// an argv command and wait for the async exit code.
func runArgv(t *testing.T, d *Dispatcher, router *collectRouter, argv []string) int {
	t.Helper()
	accepted := protocol.RPCAccepted{OpID: "op-1"}
	sync := d.handleProcessStart(argvRequest(t, argv), accepted.OpID, "api-test")
	// handleProcessStart returns nil on success (async completion) or a failed
	// payload synchronously on spawn/validation errors.
	if failed, ok := sync.(protocol.RPCFailed); ok {
		t.Fatalf("unexpected synchronous failure: %s %s", failed.Error.Code, failed.Error.Message)
	}
	return router.waitExitCode(t)
}

func TestProcessArgvMkdir(t *testing.T) {
	root := setupProcRoot(t)
	d, router := newProcessDispatcher(t, root)

	if code := runArgv(t, d, router, []string{"mkdir", "-p", "--", "newdir/child"}); code != 0 {
		t.Fatalf("mkdir exit code = %d, want 0", code)
	}
	info, err := os.Stat(filepath.Join(root, "newdir", "child"))
	if err != nil || !info.IsDir() {
		t.Fatalf("expected newdir/child to be created: %v", err)
	}
}

func TestProcessArgvMove(t *testing.T) {
	root := setupProcRoot(t)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	d, router := newProcessDispatcher(t, root)

	if code := runArgv(t, d, router, []string{"mv", "--", "a.txt", "b.txt"}); code != 0 {
		t.Fatalf("mv exit code = %d, want 0", code)
	}
	if _, err := os.Stat(filepath.Join(root, "b.txt")); err != nil {
		t.Fatalf("expected b.txt after move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected a.txt to be gone after move")
	}
}

func TestProcessArgvRmdirNonEmptyFails(t *testing.T) {
	root := setupProcRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "full", "sub"), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	d, router := newProcessDispatcher(t, root)

	// Non-recursive delete of a non-empty dir must fail (the remote backend
	// maps this stderr to directory_not_empty).
	code := runArgv(t, d, router, []string{"rmdir", "--", "full"})
	if code == 0 {
		t.Fatalf("rmdir of non-empty dir should fail")
	}
	router.mu.Lock()
	stderr := router.stderr
	router.mu.Unlock()
	if stderr == "" {
		t.Fatalf("expected stderr describing the failure")
	}
}

func TestProcessArgvRmRecursive(t *testing.T) {
	root := setupProcRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "tree", "a"), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "tree", "a", "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	d, router := newProcessDispatcher(t, root)

	if code := runArgv(t, d, router, []string{"rm", "-rf", "--", "tree"}); code != 0 {
		t.Fatalf("rm -rf exit code = %d, want 0", code)
	}
	if _, err := os.Stat(filepath.Join(root, "tree")); !os.IsNotExist(err) {
		t.Fatalf("expected tree to be removed")
	}
}

func TestProcessArgvCwdFenced(t *testing.T) {
	root := setupProcRoot(t)
	d, _ := newProcessDispatcher(t, root)

	// A cwd escaping the fenced root must be denied before spawning.
	req := protocol.RPCRequest{
		RequestScopedMessage: protocol.RequestScopedMessage{RequestID: "req-esc"},
		Method:               "process.start",
	}
	raw, _ := json.Marshal(processStartParams{Argv: []string{"ls"}, CWD: "../"})
	req.Params = raw
	result := d.handleProcessStart(req, "op-esc", "api-test")
	failed, ok := result.(protocol.RPCFailed)
	if !ok {
		t.Fatalf("expected fenced cwd to fail synchronously, got %T", result)
	}
	if failed.Error.Code != "ACCESS_DENIED" {
		t.Fatalf("expected ACCESS_DENIED, got %s", failed.Error.Code)
	}
}

func setupProcRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks: %v", err)
	}
	return root
}
