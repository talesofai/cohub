package locald

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPrepareLocalRuntimePermitRejectsNonReadyReplica(t *testing.T) {
	for _, status := range []string{"", "attaching", "syncing", "offline", "conflicted", "detached", "error"} {
		var state remoteReplicaState
		if err := json.Unmarshal([]byte(`{"lease":{"holderKind":"local_agent","expiresAt":"2099-01-01T00:00:00Z"},"replica":{"status":"`+status+`"}}`), &state); err != nil {
			t.Fatal(err)
		}
		_, err := (&Daemon{}).prepareLocalRuntimePermitFromState(&ReplicaState{
			SpaceID:   "space",
			ReplicaID: "replica",
		}, state)
		if err == nil || !strings.Contains(err.Error(), "ready local replica") {
			t.Fatalf("expected non-ready replica status %q to reject a local runtime permit", status)
		}
	}
}

func TestPrepareLocalRuntimePermitRejectsUnsynchronizedReplica(t *testing.T) {
	var state remoteReplicaState
	if err := json.Unmarshal([]byte(`{"lease":{"holderKind":"local_agent","expiresAt":"2099-01-01T00:00:00Z"},"replica":{"status":"ready","appliedSnapshotId":"remote"}}`), &state); err != nil {
		t.Fatal(err)
	}
	_, err := (&Daemon{}).prepareLocalRuntimePermitFromState(&ReplicaState{
		SpaceID:           "space",
		ReplicaID:         "replica",
		AppliedSnapshotID: "local",
	}, state)
	if err == nil || !strings.Contains(err.Error(), "synchronized replica snapshot") {
		t.Fatalf("expected mismatched replica snapshots to reject a local runtime permit, got %v", err)
	}
}

func TestPrepareLocalRuntimePermitRejectsMissingReplica(t *testing.T) {
	var state remoteReplicaState
	if err := json.Unmarshal([]byte(`{"lease":{"holderKind":"local_agent","expiresAt":"2099-01-01T00:00:00Z"},"replica":{"status":"ready"}}`), &state); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Daemon{}).prepareLocalRuntimePermitFromState(nil, state); err == nil {
		t.Fatal("expected a missing local replica to reject a runtime permit")
	}
}

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

func TestManifestOmissionProtectsOldPathDeletions(t *testing.T) {
	oldByPath := map[string]remoteEntry{
		"private":             {Path: "private", Type: "directory"},
		"private/token.txt":   {Path: "private/token.txt", Type: "file"},
		"private-other/a.txt": {Path: "private-other/a.txt", Type: "file"},
		"root.txt":            {Path: "root.txt", Type: "file"},
		"retained.txt":        {Path: "retained.txt", Type: "file"},
	}
	newByPath := map[string]remoteEntry{
		"retained.txt": {Path: "retained.txt", Type: "file"},
	}
	deletions := remoteManifestDeletionPaths(oldByPath, newByPath, []string{"private", "root.txt"})
	if len(deletions) != 1 || deletions[0] != "private-other/a.txt" {
		t.Fatalf("omitted manifest paths did not protect deletions: %#v", deletions)
	}
}

func TestRemoteApplyPreconditionRejectsStaleCanonicalState(t *testing.T) {
	state := remoteReplicaState{}
	state.Workspace.CanonicalSnapshotID = "snapshot"
	state.Workspace.Generation = 7
	if err := validateRemoteApplyPrecondition(state, "snapshot", 7, time.Time{}); err != nil {
		t.Fatalf("current canonical state rejected: %v", err)
	}

	state.Workspace.CanonicalSnapshotID = "new-snapshot"
	if err := validateRemoteApplyPrecondition(state, "snapshot", 7, time.Time{}); err == nil || !strings.Contains(err.Error(), "canonical workspace state changed") {
		t.Fatalf("expected a changed canonical snapshot to reject apply, got %v", err)
	}

	state.Workspace.CanonicalSnapshotID = "snapshot"
	state.Workspace.Generation = 8
	if err := validateRemoteApplyPrecondition(state, "snapshot", 7, time.Time{}); err == nil || !strings.Contains(err.Error(), "canonical workspace state changed") {
		t.Fatalf("expected a changed canonical generation to reject apply, got %v", err)
	}
}

func TestRemoteApplyPreconditionRejectsActiveWriterLease(t *testing.T) {
	now := time.Date(2026, time.September, 8, 12, 0, 0, 0, time.UTC)
	var state remoteReplicaState
	if err := json.Unmarshal([]byte(`{"workspace":{"canonicalSnapshotId":"snapshot","generation":7},"lease":{"expiresAt":"2026-09-08T12:00:01Z"}}`), &state); err != nil {
		t.Fatal(err)
	}
	if err := validateRemoteApplyPrecondition(state, "snapshot", 7, now); err == nil || !strings.Contains(err.Error(), "active server writer lease") {
		t.Fatalf("expected an active writer lease to reject apply, got %v", err)
	}

	state.Lease.ExpiresAt = "2026-09-08T11:59:59Z"
	if err := validateRemoteApplyPrecondition(state, "snapshot", 7, now); err != nil {
		t.Fatalf("expired writer lease rejected a current apply: %v", err)
	}
}
