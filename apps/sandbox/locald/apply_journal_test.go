package locald

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalApplyJournalRollsBackFilesDirectoriesAndCreates(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	state, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := os.MkdirAll(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "existing.txt"), []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	journal, err := createLocalApplyJournal(state, dataDir, root, "cycle", []string{"dir/existing.txt", "new.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "existing.txt"), []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := journal.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := journal.Cleanup(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "dir", "existing.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "before" {
		t.Fatalf("existing file was not restored: %q", content)
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("new file remained after rollback: %v", err)
	}
}

func TestLocalApplyJournalRecoveryRunsBeforeDaemonWork(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	state, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := createLocalApplyJournal(state, dataDir, root, "cycle", []string{"file.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := recoverLocalApplyJournals(state, dataDir); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(root, "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "before" {
		t.Fatalf("recovery did not restore file: %q", content)
	}
	pending, err := state.PendingApplyJournals()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("recovered journal remained pending: %#v", pending)
	}
}

func TestReplicaAppliedPointerAndJournalCommitAreAtomic(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	state, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := state.UpsertReplica(ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: root, RootFingerprint: "fingerprint", DeviceID: "device",
		PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled", InitialChoice: "use-cloud",
		Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	journal, err := createLocalApplyJournal(state, dataDir, root, "cycle", []string{"file.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if err := state.SetReplicaAppliedWithJournal("space", "snapshot", 2, "ready", []byte(`{"version":1}`), "cycle"); err != nil {
		t.Fatal(err)
	}
	if err := journal.Cleanup(); err != nil {
		t.Fatal(err)
	}
	replica, err := state.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if replica == nil || replica.AppliedSnapshotID != "snapshot" || replica.Generation != 2 {
		t.Fatalf("applied pointer was not committed: %#v", replica)
	}
}
