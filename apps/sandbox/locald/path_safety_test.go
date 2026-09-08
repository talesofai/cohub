package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReplicaMutationHelpersRejectIntermediateSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "existing.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("creating symlinks is unavailable: %v", err)
		}
		t.Fatal(err)
	}

	staged := filepath.Join(root, "staged.txt")
	if err := os.WriteFile(staged, []byte("staged"), 0o644); err != nil {
		t.Fatal(err)
	}
	operations := []struct {
		name string
		run  func() error
	}{
		{name: "remove", run: func() error { return removeReplicaPathChecked(root, "escape/existing.txt") }},
		{name: "mkdir", run: func() error { return mkdirAllReplicaPathChecked(root, "escape/new-dir", 0o755) }},
		{name: "symlink", run: func() error { return symlinkReplicaPathChecked(root, "existing.txt", "escape/new-link") }},
		{name: "rename", run: func() error {
			return renameReplicaPathChecked(root, "staged.txt", "escape/new-file")
		}},
	}
	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			if err := operation.run(); err == nil {
				t.Fatal("expected intermediate symlink to reject the mutation")
			}
		})
	}

	content, err := os.ReadFile(filepath.Join(outside, "existing.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "outside" {
		t.Fatalf("outside file changed: %q", content)
	}
	for _, path := range []string{"new-dir", "new-link", "new-file"} {
		if _, err := os.Lstat(filepath.Join(outside, path)); !os.IsNotExist(err) {
			t.Fatalf("mutation escaped replica root at %s: %v", path, err)
		}
	}
	if _, err := os.Stat(staged); err != nil {
		t.Fatalf("unrelated staged file changed: %v", err)
	}
}

func TestTargetPathRejectsNonCanonicalSegments(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{".", "dir/..", "dir/../file.txt", "dir//file.txt"} {
		if _, err := targetPathForReplicaChecked(root, path); err == nil {
			t.Fatalf("expected unsafe path %q to be rejected", path)
		}
	}
}

func TestLocalFileReplacementRejectsIntermediateSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("creating symlinks is unavailable: %v", err)
		}
		t.Fatal(err)
	}
	contents := []byte("replacement")
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(contents)
	replacement, err := newLocalFileReplacement(
		root,
		"cycle",
		"escape/file.txt",
		source,
		filepath.Join(root, "escape", "file.txt"),
		int64(len(contents)),
		hex.EncodeToString(hash[:]),
		0o644,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := replacement.install(); err == nil {
		t.Fatal("expected replacement through an intermediate symlink to fail")
	}
	if _, err := os.Lstat(filepath.Join(outside, "file.txt")); !os.IsNotExist(err) {
		t.Fatalf("replacement escaped replica root: %v", err)
	}
}
