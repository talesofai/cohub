package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFileReplacementParticipatesInJournalRollback(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	sourceDir := t.TempDir()
	state, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()

	destination := filepath.Join(root, "file.txt")
	if err := os.WriteFile(destination, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	contents := []byte("after")
	source := filepath.Join(sourceDir, "download")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(contents)
	replacement, err := newLocalFileReplacement(root, "cycle", "file.txt", source, destination, int64(len(contents)), hex.EncodeToString(hash[:]), 0o644)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := createLocalApplyJournal(state, dataDir, root, "cycle", []string{"file.txt", replacement.journalPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(destination); err != nil {
		t.Fatal(err)
	}
	if err := replacement.install(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("verified source should be copied, not cross-device renamed: %v", err)
	}
	if _, err := os.Stat(replacement.temporary); !os.IsNotExist(err) {
		t.Fatalf("destination-side staging file remains after install: %v", err)
	}
	if err := journal.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := journal.Cleanup(); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != "before" {
		t.Fatalf("journal restored %q, want %q", restored, "before")
	}
}

func TestLocalFileReplacementJournalRemovesInterruptedTemporaryFile(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	source := filepath.Join(t.TempDir(), "download")
	state, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()

	destination := filepath.Join(root, "file.txt")
	if err := os.WriteFile(destination, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	contents := []byte("after")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(contents)
	replacement, err := newLocalFileReplacement(root, "interrupted-cycle", "file.txt", source, destination, int64(len(contents)), hex.EncodeToString(hash[:]), 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createLocalApplyJournal(state, dataDir, root, "interrupted-cycle", []string{"file.txt", replacement.journalPath}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(destination); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(replacement.temporary, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := recoverLocalApplyJournals(state, dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(replacement.temporary); !os.IsNotExist(err) {
		t.Fatalf("interrupted destination-side staging file remains after rollback: %v", err)
	}
	restored, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != "before" {
		t.Fatalf("journal restored %q, want %q", restored, "before")
	}
}
