package locald

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReplicaMutationDirectoriesIncludeExistingAncestorsDeepestFirst(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{"a/b", "new-directory"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	directories, err := replicaMutationDirectories(root, []string{
		"a/b/file.txt",
		"deleted/path.txt",
		"new-directory",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(root, "a", "b"),
		filepath.Join(root, "a"),
		filepath.Join(root, "new-directory"),
		root,
	}
	if !reflect.DeepEqual(directories, want) {
		t.Fatalf("unexpected durability order:\n got %#v\nwant %#v", directories, want)
	}
	if err := syncDirectories(directories); err != nil {
		t.Fatal(err)
	}
}

func TestSyncDirectoryTreeIncludesJournalAndBoundaryParents(t *testing.T) {
	dataDir := t.TempDir()
	journalPath := filepath.Join(dataDir, "apply-journals", "cycle")
	if err := os.MkdirAll(filepath.Join(journalPath, "nodes", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(journalPath, "nodes", "nested", "file.txt"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syncDirectoryTree(journalPath, dataDir); err != nil {
		t.Fatal(err)
	}
}
