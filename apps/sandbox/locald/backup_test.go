package locald

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitialRecoveryBackupCommitsManifestAndContentAddressedBlobs(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.txt"), []byte("recover me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	scan, err := ScanWorkspace(root, ScanPolicy{PolicyVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	daemon := &Daemon{cfg: Config{DataDir: dataDir}}
	replica := &ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: root,
		RootFingerprint: "fingerprint", InitialChoice: "use-cloud",
	}
	backupPath, err := daemon.createInitialRecoveryBackup(replica, scan)
	if err != nil {
		t.Fatal(err)
	}
	if backupPath != filepath.Join(dataDir, "backups", "space", scan.TreeHash) {
		t.Fatalf("unexpected backup path: %s", backupPath)
	}
	if valid, err := validateRecoveryBackup(backupPath, scan); err != nil || !valid {
		t.Fatalf("committed backup is invalid: valid=%v err=%v", valid, err)
	}
	for _, blob := range scan.Blobs {
		data, err := os.ReadFile(filepath.Join(backupPath, "blobs", blob.SHA256))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "recover me\n" {
			t.Fatalf("unexpected backup blob content: %q", data)
		}
	}

	// The same immutable tree reuses the already committed backup.
	reusedPath, err := daemon.createInitialRecoveryBackup(replica, scan)
	if err != nil {
		t.Fatal(err)
	}
	if reusedPath != backupPath {
		t.Fatalf("backup was not reused: %s != %s", reusedPath, backupPath)
	}
}

func TestInitialRecoveryBackupRejectsAChangedSource(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	scan, err := ScanWorkspace(root, ScanPolicy{PolicyVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	daemon := &Daemon{cfg: Config{DataDir: t.TempDir()}}
	_, err = daemon.createInitialRecoveryBackup(&ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: root, RootFingerprint: "fingerprint",
	}, scan)
	if err == nil {
		t.Fatal("expected backup creation to reject a changed source")
	}
}
