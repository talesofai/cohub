package locald

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStateStorePersistsSpoolIdempotently(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first, err := store.AppendSpool("event-1", []byte(`{"type":"hook"}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.AppendSpool("event-1", []byte(`{"different":"ignored"}`))
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("duplicate event allocated sequences %d and %d", first, second)
	}
	items, err := store.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].EventID != "event-1" {
		t.Fatalf("unexpected spool items: %#v", items)
	}
	if err := store.MarkSpoolResult(first, true, ""); err != nil {
		t.Fatal(err)
	}
	items, err = store.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("applied spool item remained pending: %#v", items)
	}
}

func TestReplicaForPathChoosesDeepestRoot(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertReplica(ReplicaState{SpaceID: "outer", ReplicaID: "outer-r", Root: "/tmp/project", RootFingerprint: "outer-f", DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertReplica(ReplicaState{SpaceID: "inner", ReplicaID: "inner-r", Root: "/tmp/project/packages", RootFingerprint: "inner-f", DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	result, err := store.ReplicaForPath("/tmp/project/packages/protocol")
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.SpaceID != "inner" {
		t.Fatalf("expected deepest replica, got %#v", result)
	}
}

func TestReplicaReconfigurePreservesAppliedAndCandidateState(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	initial := ReplicaState{
		SpaceID:                  "space",
		ReplicaID:                "replica",
		Root:                     "/tmp/project",
		RootFingerprint:          "fingerprint",
		DeviceID:                 "device",
		PolicyVersion:            1,
		IntegrationPolicyVersion: 1,
		MirrorMode:               "full",
		InitialChoice:            "merge",
		Status:                   "ready",
		UpdatedAt:                time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := store.UpsertReplica(initial); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReplicaApplied("space", "applied", 7, "ready", []byte(`{"version":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReplicaCandidate("space", "candidate", "tree", 8, []byte(`{"version":1,"candidate":true}`), "applied", "watcher"); err != nil {
		t.Fatal(err)
	}
	initial.PolicyVersion = 2
	initial.IntegrationPolicyVersion = 3
	initial.MirrorMode = "metadata_only"
	if err := store.UpsertReplica(initial); err != nil {
		t.Fatal(err)
	}
	result, err := store.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatal("replica disappeared after reconfigure")
	}
	if result.AppliedSnapshotID != "applied" || result.Generation != 7 || string(result.Manifest) != `{"version":1}` {
		t.Fatalf("applied state was overwritten: %#v", result)
	}
	if result.CandidateSnapshotID != "candidate" || result.CandidateTreeHash != "tree" || result.CandidateGeneration != 8 || string(result.CandidateManifest) != `{"version":1,"candidate":true}` {
		t.Fatalf("candidate state was overwritten: %#v", result)
	}
	if result.PolicyVersion != 2 || result.IntegrationPolicyVersion != 3 || result.MirrorMode != "metadata_only" || result.InitialChoice != "merge" {
		t.Fatalf("configuration was not updated: %#v", result)
	}
}

func TestReplicaRebindResetsServerPointersButKeepsWorkingTreeAttachment(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	initial := ReplicaState{
		SpaceID: "space", ReplicaID: "replica-old", Root: "/tmp/project", RootFingerprint: "fingerprint-old",
		DeviceID: "device-old", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled",
		InitialChoice: "use-cloud", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := store.UpsertReplica(initial); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReplicaApplied("space", "snapshot-old", 8, "ready", []byte(`{"version":1}`)); err != nil {
		t.Fatal(err)
	}
	initial.ReplicaID = "replica-new"
	initial.DeviceID = "device-new"
	initial.RootFingerprint = "fingerprint-new"
	initial.InitialChoice = "merge"
	initial.Status = "attaching"
	if err := store.UpsertReplica(initial); err != nil {
		t.Fatal(err)
	}
	rebound, err := store.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if rebound == nil || rebound.ReplicaID != "replica-new" || rebound.DeviceID != "device-new" {
		t.Fatalf("replica identity was not rebound: %#v", rebound)
	}
	if rebound.AppliedSnapshotID != "" || rebound.CanonicalSnapshotID != "" || rebound.Generation != 0 || len(rebound.Manifest) != 0 {
		t.Fatalf("old server pointers survived replica rebind: %#v", rebound)
	}
	if rebound.InitialChoice != "merge" || rebound.Status != "attaching" {
		t.Fatalf("new attach strategy was not installed: %#v", rebound)
	}
}

func TestReplicaCandidateCannotBeReplacedBeforeResolution(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertReplica(ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: "/tmp/project", RootFingerprint: "fingerprint",
		DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled",
		InitialChoice: "merge", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReplicaCandidate("space", "candidate-a", "tree-a", 1, []byte(`{"version":1}`), "", "initial_merge"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReplicaCandidate("space", "candidate-b", "tree-b", 2, []byte(`{"version":1}`), "", "initial_merge"); err == nil {
		t.Fatal("expected a pending candidate replacement to fail")
	}
	if err := store.UpsertReplica(ReplicaState{
		SpaceID: "space", ReplicaID: "new-replica", Root: "/tmp/project", RootFingerprint: "new-fingerprint",
		DeviceID: "new-device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled",
		InitialChoice: "merge", Status: "attaching", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err == nil {
		t.Fatal("expected replica rebind with a pending candidate to fail")
	}
	result, err := store.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.CandidateSnapshotID != "candidate-a" || result.CandidateTreeHash != "tree-a" {
		t.Fatalf("pending candidate changed after rejected replacement: %#v", result)
	}
}

func TestReplicaPolicyRefreshPersistsRevokedMirrorConsent(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertReplica(ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: "/tmp/project", RootFingerprint: "fingerprint",
		DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "full",
		InitialChoice: "merge", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateReplicaPolicy("space", 2, 4, "disabled"); err != nil {
		t.Fatal(err)
	}
	replica, err := store.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if replica == nil || replica.PolicyVersion != 2 || replica.IntegrationPolicyVersion != 4 || replica.MirrorMode != "disabled" {
		t.Fatalf("revoked mirror policy was not persisted: %#v", replica)
	}
}

func TestReplicaRootOverlapIsRejectedWithoutExplicitBoundary(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertReplica(ReplicaState{
		SpaceID: "outer", ReplicaID: "outer-replica", Root: "/tmp/project", RootFingerprint: "outer-fingerprint",
		DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "disabled", Status: "ready", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.AssertReplicaRootAvailable("inner", "inner-replica", "/tmp/project/packages"); err == nil {
		t.Fatal("expected nested replica root to be rejected")
	}
	if err := store.AssertReplicaRootAvailable("same", "same-replica", "/tmp/project"); err == nil {
		t.Fatal("expected exact replica root collision to be rejected")
	}
}

func TestStateDatabaseIsCreatedWithRestrictedPermissions(t *testing.T) {
	dataDir := t.TempDir()
	store, err := OpenState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dataDir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state database permissions are too broad: %o", info.Mode().Perm())
	}
}
