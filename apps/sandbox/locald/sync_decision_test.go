package locald

import "testing"

func TestInitialCandidateBaseFollowsAttachStrategy(t *testing.T) {
	replica := &ReplicaState{InitialChoice: "merge"}
	state := remoteReplicaState{}
	state.Workspace.CanonicalSnapshotID = "cloud-canonical"
	base, source := candidateProvenance(replica, state)
	if base != "" || source != "initial_merge" {
		t.Fatalf("merge provenance is unsafe: base=%q source=%q", base, source)
	}

	replica.InitialChoice = "use-local"
	base, source = candidateProvenance(replica, state)
	if base != "cloud-canonical" || source != "initial_use_local" {
		t.Fatalf("use-local provenance is unsafe: base=%q source=%q", base, source)
	}

	replica.AppliedSnapshotID = "locally-applied"
	base, source = candidateProvenance(replica, state)
	if base != "locally-applied" || source != "watcher" {
		t.Fatalf("normal candidate did not use the applied base: base=%q source=%q", base, source)
	}
}

func TestCandidateApplyAllowsServerAddedNonOverlappingPaths(t *testing.T) {
	candidate := []byte(`{"version":1,"policyVersion":1,"scanPolicyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[{"path":"local.txt","type":"file","size":5,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","executable":false}],"boundaries":[],"portableGitState":null}`)
	current := []byte(`{"version":1,"policyVersion":1,"scanPolicyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[{"path":"local.txt","type":"file","size":5,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","executable":false}],"boundaries":[],"portableGitState":null}`)
	target := remoteManifest{
		Version: 1, PolicyVersion: 1,
		ScanPolicyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Entries: []remoteEntry{
			{Path: "local.txt", Type: "file", Size: 5, SHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
			{Path: "cloud.txt", Type: "file", Size: 6, SHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
		},
	}
	if err := candidateApplyIsSafe(candidate, current, target); err != nil {
		t.Fatalf("cloud-only path incorrectly blocked candidate apply: %v", err)
	}
}

func TestCandidateApplyRejectsPostUploadLocalEdit(t *testing.T) {
	candidate := []byte(`{"version":1,"policyVersion":1,"scanPolicyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[{"path":"local.txt","type":"file","size":5,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","executable":false}],"boundaries":[],"portableGitState":null}`)
	current := []byte(`{"version":1,"policyVersion":1,"scanPolicyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[{"path":"local.txt","type":"file","size":5,"sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","executable":false}],"boundaries":[],"portableGitState":null}`)
	target := remoteManifest{
		Version: 1, PolicyVersion: 1,
		ScanPolicyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Entries:        []remoteEntry{{Path: "local.txt", Type: "file", Size: 5, SHA256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}},
	}
	if err := candidateApplyIsSafe(candidate, current, target); err == nil {
		t.Fatal("expected post-upload local edit to block remote apply")
	}
}
