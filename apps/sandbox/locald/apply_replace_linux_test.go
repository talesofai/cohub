package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestLocalFileReplacementAcrossFilesystems(t *testing.T) {
	root := t.TempDir()
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		t.Skip("filesystem device identity is unavailable")
	}

	var sourceDir string
	for _, candidate := range []string{"/dev/shm", "/run/shm"} {
		candidateInfo, statErr := os.Stat(candidate)
		if statErr != nil || !candidateInfo.IsDir() {
			continue
		}
		candidateStat, statOK := candidateInfo.Sys().(*syscall.Stat_t)
		if !statOK || candidateStat.Dev == rootStat.Dev {
			continue
		}
		sourceDir, err = os.MkdirTemp(candidate, "cohub-locald-cross-device-")
		if err == nil {
			break
		}
	}
	if sourceDir == "" {
		t.Skip("no writable filesystem distinct from the test workspace")
	}
	t.Cleanup(func() { _ = os.RemoveAll(sourceDir) })

	contents := []byte("cross-device contents")
	source := filepath.Join(sourceDir, "download")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "nested", "file.txt")
	hash := sha256.Sum256(contents)
	replacement, err := newLocalFileReplacement(root, "cycle", "nested/file.txt", source, destination, int64(len(contents)), hex.EncodeToString(hash[:]), 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if err := replacement.install(); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(installed) != string(contents) {
		t.Fatalf("installed %q, want %q", installed, contents)
	}
}
