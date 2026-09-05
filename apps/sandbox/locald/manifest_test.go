package locald

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalJSONMatchesJCSKeyOrdering(t *testing.T) {
	hash, canonical, err := CanonicalHash([]byte(`{"z":1,"a":[{"b":true,"a":null}],"m":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != `{"a":[{"a":null,"b":true}],"m":"x","z":1}` {
		t.Fatalf("unexpected canonical JSON: %s", canonical)
	}
	if len(hash) != 64 {
		t.Fatalf("unexpected hash: %s", hash)
	}
}

func TestScanWorkspaceIncludesDirectoriesAndRedactsSensitiveFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("TOKEN=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := ScanWorkspace(root, ScanPolicy{PolicyVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Blobs) != 1 || result.Blobs[0].Path != "src/main.go" {
		t.Fatalf("unexpected blobs: %#v", result.Blobs)
	}
	if len(result.Warnings) != 1 || result.Warnings[0].Path != ".env" {
		t.Fatalf("unexpected warnings: %#v", result.Warnings)
	}
	omitted, _ := result.Manifest["omitted"].([]string)
	if len(omitted) != 1 || omitted[0] != ".env" {
		t.Fatalf("omitted paths were not recorded: %#v", result.Manifest["omitted"])
	}
}

func TestScanWorkspaceRejectsWindowsReservedName(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "CON"), []byte("reserved"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ScanWorkspace(root, ScanPolicy{PolicyVersion: 1})
	if err == nil {
		t.Fatal("expected reserved path to fail")
	}
	scanErr, ok := err.(*ScanError)
	if !ok || scanErr.Code != "path_unsupported" {
		t.Fatalf("unexpected error: %T %v", err, err)
	}
}

func TestScanWorkspaceRejectsCaseCollision(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"README.md", "readme.md"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, err := ScanWorkspace(root, ScanPolicy{PolicyVersion: 1})
	if err == nil {
		t.Fatal("expected path collision")
	}
	scanErr, ok := err.(*ScanError)
	if !ok || scanErr.Code != "path_collision" {
		t.Fatalf("unexpected error: %T %v", err, err)
	}
}
