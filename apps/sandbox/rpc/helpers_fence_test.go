package rpc

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cohub/apps/sandbox/env"
)

func TestResolveSandboxPathFence(t *testing.T) {
	root := t.TempDir()
	// Resolve symlinks on the temp dir (macOS /var -> /private/var) so the fence
	// root matches what EvalSymlinks returns for children.
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("evalsymlinks root: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	cfg := env.Config{WorkspaceDir: root, Fence: true}

	tests := []struct {
		name    string
		raw     string
		cwd     string
		wantErr bool
	}{
		{name: "inside relative", raw: "sub/file.txt", cwd: root, wantErr: false},
		{name: "inside new file", raw: "sub/new.txt", cwd: root, wantErr: false},
		{name: "root itself", raw: ".", cwd: root, wantErr: false},
		{name: "escape via dotdot", raw: "../outside.txt", cwd: root, wantErr: true},
		{name: "absolute escape", raw: "/etc/passwd", cwd: root, wantErr: true},
		{name: "nested dotdot escape", raw: "sub/../../etc/passwd", cwd: root, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := resolveSandboxPath(cfg, tt.raw, tt.cwd)
			if tt.wantErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tt.raw)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error for %q: %v", tt.raw, err)
			}
		})
	}
}

func TestResolveSandboxPathVirtualWorkspaceAlias(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks root: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	cfg := env.Config{WorkspaceDir: root, Fence: true}
	tests := []struct {
		name string
		raw  string
		cwd  string
		want string
	}{
		{name: "virtual root", raw: ".", cwd: "/workspace", want: root},
		{name: "virtual child", raw: "/workspace/sub", cwd: root, want: filepath.Join(root, "sub")},
		{name: "relative from virtual cwd", raw: "sub", cwd: "/workspace", want: filepath.Join(root, "sub")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveSandboxPath(cfg, tt.raw, tt.cwd)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.path != tt.want {
				t.Fatalf("path mismatch: got %q want %q", got.path, tt.want)
			}
		})
	}

	if _, err := resolveSandboxPath(cfg, "/workspace/../outside", root); err == nil {
		t.Fatalf("expected cleaned virtual escape to be denied")
	}
}

func TestResolveSandboxPathSymlinkEscape(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks: %v", err)
	}
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("evalsymlinks outside: %v", err)
	}
	// A symlink inside the root pointing outside must not grant access.
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	cfg := env.Config{WorkspaceDir: root, Fence: true}
	if _, err := resolveSandboxPath(cfg, "escape/secret.txt", root); err == nil {
		t.Fatalf("expected symlink escape to be denied")
	}
}

func TestResolveSandboxPathNoFence(t *testing.T) {
	cfg := env.Config{WorkspaceDir: "/workspace", Fence: false}
	// Without fencing, host-like access is allowed (cloud semantics).
	if _, err := resolveSandboxPath(cfg, "/etc/hosts", "/workspace"); err != nil {
		t.Fatalf("unfenced access should be allowed: %v", err)
	}
}
