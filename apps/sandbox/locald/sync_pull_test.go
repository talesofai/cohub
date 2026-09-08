package locald

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareCanonicalPullUploadsChangedLocalTree(t *testing.T) {
	for _, mode := range []string{"two_way_safe", "one_way_to_cloud"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("base"), 0o644); err != nil {
				t.Fatal(err)
			}
			state := canonicalPullTestState(mode)
			base, err := ScanWorkspace(root, scanPolicyFromRemote(state))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("changed"), 0o644); err != nil {
				t.Fatal(err)
			}

			preparation, err := (&Daemon{}).prepareCanonicalPull(&ReplicaState{Root: root, Manifest: base.ManifestBytes}, state)
			if err != nil {
				t.Fatal(err)
			}
			if !preparation.uploadLocal || preparation.allowDestructive {
				t.Fatalf("unexpected canonical pull preparation: %#v", preparation)
			}
		})
	}
}

func TestPrepareCanonicalPullBacksUpChangedOneWayToLocalTree(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("base"), 0o644); err != nil {
		t.Fatal(err)
	}
	state := canonicalPullTestState("one_way_to_local")
	base, err := ScanWorkspace(root, scanPolicyFromRemote(state))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	current, err := ScanWorkspace(root, scanPolicyFromRemote(state))
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	replica := &ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: root, RootFingerprint: "fingerprint",
		Manifest: base.ManifestBytes,
	}

	preparation, err := (&Daemon{cfg: Config{DataDir: dataDir}}).prepareCanonicalPull(replica, state)
	if err != nil {
		t.Fatal(err)
	}
	if preparation.uploadLocal || !preparation.allowDestructive {
		t.Fatalf("unexpected canonical pull preparation: %#v", preparation)
	}
	if !bytes.Equal(replica.Manifest, current.ManifestBytes) {
		t.Fatal("prepared pull did not retain the backed-up local manifest")
	}
	backupPath := filepath.Join(dataDir, "backups", replica.SpaceID, current.TreeHash)
	if valid, err := validateRecoveryBackup(backupPath, current); err != nil || !valid {
		t.Fatalf("recovery backup is invalid: valid=%v err=%v", valid, err)
	}
}

func TestPrepareCanonicalPullAllowsUnchangedTree(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("base"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"two_way_safe", "one_way_to_cloud", "one_way_to_local"} {
		t.Run(mode, func(t *testing.T) {
			state := canonicalPullTestState(mode)
			base, err := ScanWorkspace(root, scanPolicyFromRemote(state))
			if err != nil {
				t.Fatal(err)
			}
			preparation, err := (&Daemon{}).prepareCanonicalPull(&ReplicaState{Root: root, Manifest: base.ManifestBytes}, state)
			if err != nil {
				t.Fatal(err)
			}
			if preparation.uploadLocal || preparation.allowDestructive {
				t.Fatalf("unchanged tree blocked canonical pull: %#v", preparation)
			}
		})
	}
}

func canonicalPullTestState(mode string) remoteReplicaState {
	state := remoteReplicaState{}
	state.WorkspacePolicy.PolicyVersion = 1
	state.WorkspacePolicy.SensitiveMode = "exclude_with_warning"
	state.WorkspacePolicy.Limits = map[string]any{}
	state.IntegrationPolicy.WorkspaceMode = mode
	return state
}
