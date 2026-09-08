package locald

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const syncManifestMaxBytes = 64 * 1024 * 1024

type remoteReplicaState struct {
	Replica struct {
		SpaceID           string `json:"spaceId"`
		ReplicaID         string `json:"id"`
		CanonicalSnapshot string `json:"canonicalSnapshotId"`
		AppliedSnapshot   string `json:"appliedSnapshotId"`
		CurrentSnapshot   string `json:"currentSnapshotId"`
		Generation        int64  `json:"generation"`
		Status            string `json:"status"`
		ActiveAttemptID   string `json:"activeExecutionAttemptId"`
	} `json:"replica"`
	Workspace struct {
		CanonicalSnapshotID    string `json:"canonicalSnapshotId"`
		CloudAppliedSnapshotID string `json:"cloudAppliedSnapshotId"`
		Generation             int64  `json:"generation"`
		Status                 string `json:"status"`
		ActiveAttemptID        string `json:"activeExecutionAttemptId"`
	} `json:"workspace"`
	WorkspacePolicy struct {
		PolicyVersion   int64          `json:"policyVersion"`
		DefaultExcludes []string       `json:"defaultExcludes"`
		CustomExcludes  []string       `json:"customExcludes"`
		SensitiveMode   string         `json:"sensitiveContentMode"`
		Limits          map[string]any `json:"limits"`
	} `json:"workspacePolicy"`
	IntegrationPolicy struct {
		IntegrationPolicyVersion int64  `json:"integrationPolicyVersion"`
		WorkspaceMode            string `json:"workspaceMode"`
	} `json:"integrationPolicy"`
	Lease *struct {
		HolderKind     string `json:"holderKind"`
		HolderID       string `json:"holderId"`
		Epoch          int64  `json:"epoch"`
		BaseSnapshotID string `json:"baseSnapshotId"`
		ExpiresAt      string `json:"expiresAt"`
	} `json:"lease"`
	// ExecutionAttempt is returned only when the state endpoint can prove that
	// the active attempt belongs to this device/replica.
	ExecutionAttempt *remoteExecutionAttempt `json:"executionAttempt"`
}

type remoteExecutionAttempt struct {
	ID              string `json:"id"`
	SpaceID         string `json:"spaceId"`
	ReplicaID       string `json:"replicaId"`
	RuntimeID       string `json:"runtimeId"`
	DeviceID        string `json:"deviceId"`
	ExecutorKind    string `json:"executorKind"`
	Status          string `json:"status"`
	BaseSnapshotID  string `json:"baseSnapshotId"`
	LeaseEpoch      int64  `json:"leaseEpoch"`
	ConnectionEpoch int64  `json:"connectionEpoch"`
	LeaseExpiresAt  string `json:"leaseExpiresAt"`
}

type remoteSnapshot struct {
	Snapshot struct {
		ID             string `json:"id"`
		TreeHash       string `json:"treeHash"`
		ManifestSHA256 string `json:"manifestSha256"`
		TotalBytes     int64  `json:"totalBytes"`
		Status         string `json:"status"`
	} `json:"snapshot"`
	Manifest         json.RawMessage `json:"manifest"`
	ManifestDownload *struct {
		DownloadURL string `json:"downloadUrl"`
	} `json:"manifestDownload"`
	Blobs []struct {
		Path     string `json:"path"`
		SHA256   string `json:"sha256"`
		Size     int64  `json:"size"`
		Download struct {
			DownloadURL string `json:"downloadUrl"`
		} `json:"download"`
	} `json:"blobs"`
}

type remoteManifest struct {
	Version          int           `json:"version"`
	PolicyVersion    int64         `json:"policyVersion"`
	ScanPolicyHash   string        `json:"scanPolicyHash"`
	Entries          []remoteEntry `json:"entries"`
	Boundaries       []any         `json:"boundaries"`
	PortableGitState any           `json:"portableGitState"`
	Omitted          []string      `json:"omitted"`
}

type remoteEntry struct {
	Path          string `json:"path"`
	Type          string `json:"type"`
	Size          int64  `json:"size,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
	Executable    bool   `json:"executable,omitempty"`
	SymlinkTarget string `json:"symlinkTarget,omitempty"`
}

type snapshotPrepareResponse struct {
	SnapshotID     string `json:"snapshotId"`
	Status         string `json:"status"`
	ManifestInline bool   `json:"manifestInline"`
	ManifestUpload *struct {
		UploadURL string            `json:"uploadUrl"`
		Headers   map[string]string `json:"headers"`
	} `json:"manifestUpload"`
	Blobs []struct {
		SHA256    string            `json:"sha256"`
		Size      int64             `json:"size"`
		ObjectKey string            `json:"objectKey"`
		Ready     bool              `json:"ready"`
		UploadURL string            `json:"uploadUrl"`
		Headers   map[string]string `json:"headers"`
	} `json:"blobs"`
}

type snapshotCommitResponse struct {
	SnapshotID string `json:"snapshotId"`
	Status     string `json:"status"`
	TreeHash   string `json:"treeHash"`
	CycleID    string `json:"cycleId"`
}

type canonicalPullPreparation struct {
	uploadLocal      bool
	allowDestructive bool
}

func scanPolicyFromRemote(state remoteReplicaState) ScanPolicy {
	return ScanPolicy{
		PolicyVersion:    state.WorkspacePolicy.PolicyVersion,
		DefaultExcludes:  state.WorkspacePolicy.DefaultExcludes,
		CustomExcludes:   state.WorkspacePolicy.CustomExcludes,
		SensitiveMode:    state.WorkspacePolicy.SensitiveMode,
		MaxEntries:       intValue(state.WorkspacePolicy.Limits["maxEntries"], 2_000_000),
		MaxFileBytes:     int64Value(state.WorkspacePolicy.Limits["maxFileBytes"], 5*1024*1024*1024),
		MaxSnapshotBytes: int64Value(state.WorkspacePolicy.Limits["maxSnapshotBytes"], 100*1024*1024*1024),
	}
}

func remoteExecutionAttemptForState(state remoteReplicaState) *remoteExecutionAttempt {
	return state.ExecutionAttempt
}

func runtimeIDForPermit(permit *PermitContext) (string, error) {
	if permit == nil || strings.TrimSpace(permit.SpaceID) == "" || strings.TrimSpace(permit.ReplicaID) == "" || strings.TrimSpace(permit.ExecutionAttemptID) == "" || strings.TrimSpace(permit.RuntimeID) == "" {
		return "", errors.New("local runtime execution permit identity is unavailable")
	}
	return strings.TrimSpace(permit.RuntimeID), nil
}

func runtimeIDForPermitState(permit *PermitContext, state remoteReplicaState) (string, error) {
	runtimeID, err := runtimeIDForPermit(permit)
	if err != nil {
		return "", err
	}
	attempt := state.ExecutionAttempt
	if attempt != nil && (attempt.ID != permit.ExecutionAttemptID || (attempt.SpaceID != "" && attempt.SpaceID != permit.SpaceID) || (attempt.ReplicaID != "" && attempt.ReplicaID != permit.ReplicaID) || (strings.TrimSpace(attempt.RuntimeID) != "" && attempt.RuntimeID != runtimeID)) {
		return "", errors.New("authoritative local runtime identity does not match the execution permit")
	}
	return runtimeID, nil
}

func remoteLeaseExpiry(lease *struct {
	HolderKind     string `json:"holderKind"`
	HolderID       string `json:"holderId"`
	Epoch          int64  `json:"epoch"`
	BaseSnapshotID string `json:"baseSnapshotId"`
	ExpiresAt      string `json:"expiresAt"`
}) (time.Time, error) {
	if lease == nil {
		return time.Time{}, errors.New("workspace writer lease is unavailable")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(lease.ExpiresAt))
	if err != nil {
		return time.Time{}, fmt.Errorf("workspace writer lease expiry is invalid: %w", err)
	}
	return expiresAt, nil
}

func activeRemoteLeaseExpiry(lease *struct {
	HolderKind     string `json:"holderKind"`
	HolderID       string `json:"holderId"`
	Epoch          int64  `json:"epoch"`
	BaseSnapshotID string `json:"baseSnapshotId"`
	ExpiresAt      string `json:"expiresAt"`
}) (time.Time, error) {
	expiresAt, err := remoteLeaseExpiry(lease)
	if err != nil {
		return time.Time{}, err
	}
	if !expiresAt.After(time.Now().UTC()) {
		return time.Time{}, errors.New("workspace writer lease has expired")
	}
	return expiresAt, nil
}

// prepareLocalRuntimePermitFromState turns an authoritative active local
// runtime lease into a local prepared permit. It returns true when the caller
// must stop all workspace synchronization because the runtime owns the tree.
// Every identity field is checked before anything is persisted locally.
func (d *Daemon) prepareLocalRuntimePermitFromState(replica *ReplicaState, state remoteReplicaState) (bool, error) {
	if state.Lease == nil {
		return false, nil
	}
	if replica == nil || strings.TrimSpace(replica.SpaceID) == "" || strings.TrimSpace(replica.ReplicaID) == "" {
		return false, errors.New("local workspace replica identity is unavailable")
	}
	expiresAt, err := remoteLeaseExpiry(state.Lease)
	if err != nil {
		return false, err
	}
	leaseExpired := !expiresAt.After(time.Now().UTC())
	if state.Lease.HolderKind != "local_agent" {
		return false, nil
	}
	if state.Replica.Status != "ready" {
		return false, errors.New("active local runtime lease requires a ready local replica")
	}
	if state.Replica.AppliedSnapshot == "" || replica.AppliedSnapshotID == "" || state.Replica.AppliedSnapshot != replica.AppliedSnapshotID {
		return false, errors.New("active local runtime lease requires a synchronized replica snapshot")
	}
	attempt := remoteExecutionAttemptForState(state)
	if attempt == nil {
		return false, errors.New("active local runtime lease has no execution attempt metadata")
	}
	if strings.TrimSpace(state.Lease.HolderID) == "" || state.Lease.HolderID != attempt.ID || attempt.ID == "" {
		return false, errors.New("active local runtime lease holder does not match its execution attempt")
	}
	if attempt.ExecutorKind != "local_runtime" || attempt.SpaceID != replica.SpaceID || attempt.ReplicaID != replica.ReplicaID || (state.Replica.ReplicaID != "" && state.Replica.ReplicaID != replica.ReplicaID) {
		return false, errors.New("active local runtime lease is bound to a different workspace")
	}
	if state.Workspace.ActiveAttemptID != "" && state.Workspace.ActiveAttemptID != attempt.ID {
		return false, errors.New("workspace active execution attempt does not match its writer lease")
	}
	if state.Replica.ActiveAttemptID != "" && state.Replica.ActiveAttemptID != attempt.ID {
		return false, errors.New("replica active execution attempt does not match its writer lease")
	}
	canonicalID := state.Workspace.CanonicalSnapshotID
	if canonicalID == "" {
		canonicalID = state.Replica.CanonicalSnapshot
	}
	if attempt.BaseSnapshotID == "" || canonicalID == "" || attempt.BaseSnapshotID != state.Lease.BaseSnapshotID || attempt.BaseSnapshotID != canonicalID || attempt.BaseSnapshotID != state.Replica.AppliedSnapshot || attempt.BaseSnapshotID != replica.AppliedSnapshotID {
		return false, errors.New("active local runtime lease base snapshot is stale")
	}
	if state.Lease.Epoch < 1 || attempt.LeaseEpoch != state.Lease.Epoch {
		return false, errors.New("active local runtime lease epoch does not match its execution attempt")
	}
	if attempt.ConnectionEpoch < 1 || strings.TrimSpace(attempt.RuntimeID) == "" {
		return false, errors.New("active local runtime execution attempt metadata is incomplete")
	}
	if attempt.DeviceID != "" && attempt.DeviceID != replica.DeviceID {
		return false, errors.New("active local runtime execution attempt belongs to another device")
	}
	if attempt.LeaseExpiresAt != "" {
		attemptExpiry, parseErr := time.Parse(time.RFC3339Nano, attempt.LeaseExpiresAt)
		if parseErr != nil || !attemptExpiry.Equal(expiresAt) {
			return false, errors.New("active local runtime execution attempt lease expiry does not match")
		}
	}
	permit, permitErr := d.state.PermitContext(attempt.ID)
	if permitErr != nil {
		return false, permitErr
	}
	if permit != nil {
		validHolder := permit.Status == "prepared" && permit.HolderID == attempt.ID
		validHolder = validHolder || permit.Status != "prepared" && isLocalRuntimePermit(permit.HolderID) && serverPermitHolderID(permit.HolderID) == attempt.ID
		if permit.ExecutionAttemptID != attempt.ID || permit.SpaceID != replica.SpaceID || permit.ReplicaID != replica.ReplicaID || permit.RuntimeID != attempt.RuntimeID || !validHolder {
			return false, errors.New("local runtime execution permit provenance is invalid")
		}
	}
	if permit != nil && permit.Status != "prepared" {
		// A consumed permit is a stronger local fence than a fresh server poll.
		if permit.Status == "active" && isLocalRuntimePermit(permit.HolderID) {
			return true, nil
		}
		return false, fmt.Errorf("local runtime execution permit is already %s", permit.Status)
	}
	if leaseExpired {
		// A prepared permit means this daemon has durably accepted the runtime
		// handoff, even if the server lease expired while the network was down.
		// Keep the disk fenced until the runtime either renews or explicitly
		// consumes/releases that permit; never let reconciliation race it.
		if permit == nil || permit.Status != "prepared" {
			return false, nil
		}
		// A prepared permit whose own deadline elapsed was never claimed by a
		// provider, so it cannot be writing the tree anymore.
		return permit.ExpiresAt.IsZero() || permit.ExpiresAt.After(time.Now().UTC()), nil
	}
	if err := d.state.PutPermit(attempt.ID, replica.SpaceID, replica.ReplicaID, attempt.RuntimeID, attempt.BaseSnapshotID, state.Lease.Epoch, expiresAt, "local_agent", attempt.ID); err != nil {
		return false, err
	}
	return true, nil
}

// refreshLocalRuntimePermit fetches the authoritative state immediately before
// a relay channel starts. The normal five-second sync poll remains useful for
// caching, but cannot be the only preparation window for a short-lived lease.
func (d *Daemon) refreshLocalRuntimePermit(ctx context.Context, ref runtimeAttemptRef) error {
	body, err := d.getJSON(ctx, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/state", d.apiBaseURL(), ref.spaceID, ref.replicaID))
	if err != nil {
		return err
	}
	var state remoteReplicaState
	if err := json.Unmarshal(body, &state); err != nil {
		return err
	}
	replica, err := d.state.ReplicaForSpace(ref.spaceID)
	if err != nil {
		return err
	}
	if replica == nil || replica.ReplicaID != ref.replicaID {
		return errors.New("local workspace replica is unavailable")
	}
	attempt := remoteExecutionAttemptForState(state)
	if attempt == nil || attempt.ID != ref.attemptID || strings.TrimSpace(ref.runtimeID) == "" || attempt.RuntimeID != ref.runtimeID || attempt.ConnectionEpoch != ref.connectionEpoch || attempt.LeaseEpoch != ref.leaseEpoch || attempt.BaseSnapshotID != ref.baseSnapshotID {
		return errors.New("authoritative local runtime lease does not match the channel binding")
	}
	lease := state.Lease
	if lease == nil || lease.HolderID != ref.attemptID || lease.Epoch != ref.leaseEpoch || lease.BaseSnapshotID != ref.baseSnapshotID {
		return errors.New("authoritative workspace lease does not match the channel binding")
	}
	expiresAt, err := activeRemoteLeaseExpiry(lease)
	if err != nil || !expiresAt.Equal(ref.expiresAt) {
		return errors.New("authoritative workspace lease expiry does not match the channel binding")
	}
	prepared, err := d.prepareLocalRuntimePermitFromState(replica, state)
	if err != nil {
		return err
	}
	if !prepared {
		return errors.New("authoritative local runtime lease is unavailable")
	}
	return nil
}

func (d *Daemon) syncReplicas(ctx context.Context) {
	d.heartbeatActivePermits(ctx)
	items, err := d.localReplicas()
	if err != nil {
		return
	}
	for _, replica := range items {
		if err := d.syncReplica(ctx, replica); err != nil {
			// A busy or unavailable network is expected during offline work. The
			// next generation poll retries it; no local bytes are discarded.
			continue
		}
	}
}

// heartbeatLocalRuntimePermits is run only by the local runtime host process. The ordinary
// daemon deliberately does not renew local runtime permits because it cannot prove that
// the provider connection is still mutating the replica.
func (d *Daemon) heartbeatLocalRuntimePermits(ctx context.Context, isAttemptActive func(string) bool) {
	refresh := func() {
		permits, err := d.state.ActivePermits(ctx)
		if err != nil {
			return
		}
		now := time.Now().UTC()
		for _, permit := range permits {
			if !isLocalRuntimePermit(permit.HolderID) || !isAttemptActive(serverPermitHolderID(permit.HolderID)) || permit.ExpiresAt.IsZero() || !permit.ExpiresAt.After(now) {
				continue
			}
			_ = d.state.UpdatePermitExpiry(permit.ExecutionAttemptID, now.Add(30*time.Second))
		}
	}
	refresh()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}

func (d *Daemon) heartbeatActivePermits(ctx context.Context) {
	permits, err := d.state.ActivePermits(ctx)
	if err != nil {
		return
	}
	for _, permit := range permits {
		if permit.LeaseEpoch <= 0 || permit.ExpiresAt.Before(time.Now().UTC()) || isLocalRuntimePermit(permit.HolderID) {
			continue
		}
		payload := mustJSON(map[string]any{
			"holderKind":      permit.HolderKind,
			"holderId":        serverPermitHolderID(permit.HolderID),
			"epoch":           permit.LeaseEpoch,
			"durationSeconds": 30,
		})
		body, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/leases/heartbeat", d.apiBaseURL(), permit.SpaceID), payload, 2*1024*1024)
		if err != nil {
			continue
		}
		var response struct {
			ExpiresAt string `json:"expiresAt"`
		}
		if json.Unmarshal(body, &response) != nil {
			continue
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, response.ExpiresAt)
		if err == nil {
			_ = d.state.UpdatePermitExpiry(permit.ExecutionAttemptID, expiresAt)
		}
	}
}

func (d *Daemon) localReplicas() ([]*ReplicaState, error) {
	rows, err := d.state.db.Query(`SELECT space_id, replica_id, root, root_fingerprint, device_id, policy_version, integration_policy_version, COALESCE(canonical_snapshot_id, ''), COALESCE(applied_snapshot_id, ''), generation, status, COALESCE(manifest, X''), COALESCE(candidate_snapshot_id, ''), COALESCE(candidate_tree_hash, ''), COALESCE(candidate_generation, 0), COALESCE(candidate_manifest, X''), COALESCE(candidate_base_snapshot_id, ''), COALESCE(candidate_source, ''), COALESCE(initial_choice, ''), updated_at FROM replicas`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []*ReplicaState
	for rows.Next() {
		item := &ReplicaState{}
		if err := rows.Scan(&item.SpaceID, &item.ReplicaID, &item.Root, &item.RootFingerprint, &item.DeviceID, &item.PolicyVersion, &item.IntegrationPolicyVersion, &item.CanonicalSnapshotID, &item.AppliedSnapshotID, &item.Generation, &item.Status, &item.Manifest, &item.CandidateSnapshotID, &item.CandidateTreeHash, &item.CandidateGeneration, &item.CandidateManifest, &item.CandidateBaseSnapshotID, &item.CandidateSource, &item.InitialChoice, &item.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (d *Daemon) syncReplica(ctx context.Context, replica *ReplicaState) error {
	if replica == nil || replica.SpaceID == "" || replica.ReplicaID == "" {
		return errors.New("replica identity is incomplete")
	}
	if _, _, valid, err := d.activePermit(replica.SpaceID); err != nil {
		return err
	} else if valid {
		return nil
	}
	stateBody, err := d.getJSON(ctx, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/state", d.apiBaseURL(), replica.SpaceID, replica.ReplicaID))
	if err != nil {
		return err
	}
	var state remoteReplicaState
	if err := json.Unmarshal(stateBody, &state); err != nil {
		return err
	}
	if runtimeOwned, err := d.prepareLocalRuntimePermitFromState(replica, state); err != nil {
		return err
	} else if runtimeOwned {
		// A local runtime lease is a write fence. The provider channel will claim
		// the prepared permit; until then no sync/apply operation may touch disk.
		return nil
	}
	if state.WorkspacePolicy.PolicyVersion < 1 || state.IntegrationPolicy.IntegrationPolicyVersion < 1 {
		return errors.New("workspace or integration policy is unavailable")
	}
	if err := d.state.UpdateReplicaPolicy(replica.SpaceID, state.WorkspacePolicy.PolicyVersion, state.IntegrationPolicy.IntegrationPolicyVersion); err != nil {
		return err
	}
	if state.Lease != nil {
		expiresAt, parseErr := time.Parse(time.RFC3339Nano, state.Lease.ExpiresAt)
		if parseErr != nil {
			return fmt.Errorf("workspace writer lease expiry is invalid: %w", parseErr)
		}
		if expiresAt.After(time.Now().UTC()) {
			return fmt.Errorf("workspace has an active server writer lease: %s", state.Lease.HolderKind)
		}
	}
	replica.PolicyVersion = state.WorkspacePolicy.PolicyVersion
	replica.IntegrationPolicyVersion = state.IntegrationPolicy.IntegrationPolicyVersion
	canonicalID := state.Workspace.CanonicalSnapshotID
	if canonicalID == "" {
		canonicalID = state.Replica.CanonicalSnapshot
	}
	if canonicalID == "" {
		if replica.CandidateSnapshotID != "" || (replica.AppliedSnapshotID == "" && (replica.InitialChoice == "use-local" || replica.InitialChoice == "merge")) {
			return d.uploadLocalCandidate(ctx, replica, state, "")
		}
		// use-cloud waits for the bootstrap worker to establish the first
		// canonical snapshot; no local bytes are changed while it is absent.
		return nil
	}

	// A local candidate is an outstanding write, not a cache entry. Until the
	// server reports that the candidate itself (or a later result snapshot) is
	// the replica's current canonical version, a remote pull must not touch the
	// working tree. This remains conservative across daemon crashes.
	if replica.CandidateSnapshotID != "" {
		if state.Workspace.Status == "conflicted" || state.Replica.Status == "conflicted" {
			return fmt.Errorf("workspace candidate is unresolved: %s", replica.CandidateSnapshotID)
		}
		serverCurrent := state.Replica.CurrentSnapshot
		candidateIsCanonical := serverCurrent == replica.CandidateSnapshotID && canonicalID == replica.CandidateSnapshotID && state.Replica.Status == "ready" && state.Workspace.Status == "ready"
		candidateResolved := serverCurrent != "" && serverCurrent == canonicalID && serverCurrent != replica.CandidateSnapshotID
		if !candidateIsCanonical && !candidateResolved {
			if serverCurrent == "" || serverCurrent == replica.CandidateSnapshotID {
				return d.uploadLocalCandidate(ctx, replica, state, "")
			}
			return fmt.Errorf("workspace candidate has not reached the canonical pointer: %s", replica.CandidateSnapshotID)
		}
	}
	if replica.AppliedSnapshotID == "" && replica.CandidateSnapshotID == "" {
		if state.Workspace.Status != "ready" {
			return nil
		}
		switch replica.InitialChoice {
		case "use-local", "merge":
			return d.uploadLocalCandidate(ctx, replica, state, "")
		case "use-cloud":
			// Continue below and materialize the canonical snapshot after a
			// recoverable local backup has been committed.
		default:
			return errors.New("initial workspace reconciliation choice is missing")
		}
	}
	forceCloudAuthoritative := false
	if canonicalID == replica.AppliedSnapshotID && state.IntegrationPolicy.WorkspaceMode == "one_way_to_local" {
		current, scanErr := ScanWorkspace(replica.Root, scanPolicyFromRemote(state))
		if scanErr != nil {
			return scanErr
		}
		storedTreeHash, hashErr := storedManifestTreeHash(replica.Manifest)
		if hashErr != nil {
			return hashErr
		}
		if current.TreeHash == storedTreeHash {
			if state.Replica.AppliedSnapshot != canonicalID {
				return d.ackApplied(ctx, replica, canonicalID, state.Workspace.Generation)
			}
			return nil
		}
		// The cloud is authoritative under one_way_to_local, but local edits are
		// still user data. Keep a recoverable copy before they are replaced.
		if _, err := d.createInitialRecoveryBackup(replica, current); err != nil {
			return fmt.Errorf("create one-way-to-local recovery backup: %w", err)
		}
		replica.Manifest = current.ManifestBytes
		forceCloudAuthoritative = true
	}
	if canonicalID == replica.AppliedSnapshotID && !forceCloudAuthoritative {
		if state.Replica.AppliedSnapshot != canonicalID {
			return d.ackApplied(ctx, replica, canonicalID, state.Workspace.Generation)
		}
		if state.Workspace.Status != "ready" {
			return nil
		}
		return d.uploadLocalCandidate(ctx, replica, state, "")
	}
	if state.Workspace.Status != "ready" && state.Workspace.Status != "syncing" {
		return fmt.Errorf("workspace is not ready: %s", state.Workspace.Status)
	}
	if canonicalID != replica.AppliedSnapshotID && replica.AppliedSnapshotID != "" && replica.CandidateSnapshotID == "" {
		preparation, prepareErr := d.prepareCanonicalPull(replica, state)
		if prepareErr != nil {
			return prepareErr
		}
		if preparation.uploadLocal {
			return d.uploadLocalCandidate(ctx, replica, state, "")
		}
		forceCloudAuthoritative = preparation.allowDestructive
	}
	snapshotBody, err := d.getJSON(ctx, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/snapshots/%s", d.apiBaseURL(), replica.SpaceID, replica.ReplicaID, canonicalID))
	if err != nil {
		return err
	}
	var snapshot remoteSnapshot
	if err := json.Unmarshal(snapshotBody, &snapshot); err != nil {
		return err
	}
	manifestRaw, err := d.resolveManifest(ctx, snapshot)
	if err != nil {
		return err
	}
	var manifest remoteManifest
	if len(manifestRaw) > syncManifestMaxBytes {
		return errors.New("remote workspace manifest exceeds the configured limit")
	}
	manifestHash, _, err := CanonicalHash(manifestRaw)
	if err != nil {
		return fmt.Errorf("canonicalize remote workspace manifest: %w", err)
	}
	if snapshot.Snapshot.ManifestSHA256 != "" && manifestHash != snapshot.Snapshot.ManifestSHA256 {
		return errors.New("remote workspace manifest hash does not match its snapshot descriptor")
	}
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		return fmt.Errorf("decode remote workspace manifest: %w", err)
	}
	if manifest.Version != 1 || manifest.PolicyVersion < 1 {
		return errors.New("remote workspace manifest version is unsupported")
	}
	manifestTreeHash, err := remoteManifestTreeHash(manifestRaw)
	if err != nil {
		return fmt.Errorf("hash remote workspace tree: %w", err)
	}
	if snapshot.Snapshot.TreeHash == "" || manifestTreeHash != snapshot.Snapshot.TreeHash {
		return errors.New("remote workspace tree hash does not match its manifest")
	}
	blobByPath := make(map[string]struct {
		sha256 string
		size   int64
		url    string
	}, len(snapshot.Blobs))
	for _, blob := range snapshot.Blobs {
		blobByPath[blob.Path] = struct {
			sha256 string
			size   int64
			url    string
		}{blob.SHA256, blob.Size, blob.Download.DownloadURL}
	}
	allowDestructive := forceCloudAuthoritative
	if replica.AppliedSnapshotID == "" || replica.CandidateSnapshotID != "" {
		current, scanErr := ScanWorkspace(replica.Root, scanPolicyFromRemote(state))
		if scanErr != nil {
			return scanErr
		}
		if current.TreeHash == snapshot.Snapshot.TreeHash {
			if err := d.state.SetReplicaApplied(replica.SpaceID, canonicalID, state.Workspace.Generation, "ready", manifestRaw); err != nil {
				return err
			}
			return d.ackApplied(ctx, replica, canonicalID, state.Workspace.Generation)
		}
		if replica.CandidateSnapshotID != "" {
			if err := candidateApplyIsSafe(replica.CandidateManifest, current.ManifestBytes, manifest); err != nil {
				return err
			}
			replica.Manifest = replica.CandidateManifest
		} else {
			if replica.InitialChoice != "use-cloud" {
				return errors.New("initial workspace state diverged without a use-cloud decision")
			}
			if _, err := d.createInitialRecoveryBackup(replica, current); err != nil {
				return fmt.Errorf("create initial workspace recovery backup: %w", err)
			}
			replica.Manifest = current.ManifestBytes
			allowDestructive = true
		}
	}
	if err := d.applyRemoteSnapshot(ctx, replica, manifest, blobByPath, canonicalID, state.Workspace.Generation, snapshot.Snapshot.TreeHash, state.WorkspacePolicy, manifestRaw, allowDestructive); err != nil {
		return err
	}
	return nil
}

type localRuntimeLeaseHeartbeat struct {
	stop  func()
	check func() error
}

// recoverLocalRuntimeLease re-opens the exact writer lease that produced a
// terminal local-runtime spool record. Recovery deliberately keeps the same
// holder and epoch: a newer writer must make this request fail rather than
// allowing an old provider host to regain workspace authority.
func (d *Daemon) recoverLocalRuntimeLease(ctx context.Context, spaceID string, permit *PermitContext, runtimeID string) error {
	if permit == nil {
		return errors.New("local runtime execution permit is unavailable for lease recovery")
	}
	if permit.HolderKind != "local_agent" || strings.TrimSpace(permit.ExecutionAttemptID) == "" || strings.TrimSpace(permit.SpaceID) != strings.TrimSpace(spaceID) {
		return errors.New("local runtime execution permit provenance is invalid for lease recovery")
	}
	expectedHolderID := serverPermitHolderID(permit.HolderID)
	if expectedHolderID == "" || expectedHolderID != permit.ExecutionAttemptID {
		return errors.New("local runtime execution permit holder is invalid for lease recovery")
	}
	if permit.Status == "prepared" {
		if permit.HolderID != expectedHolderID {
			return errors.New("prepared local runtime execution permit holder is invalid for lease recovery")
		}
	} else if permit.Status == "active" || permit.Status == "expired" {
		if permit.HolderID != localRuntimePermitHolderID(expectedHolderID) {
			return errors.New("consumed local runtime execution permit holder is invalid for lease recovery")
		}
	} else {
		return fmt.Errorf("local runtime execution permit is already %s", permit.Status)
	}
	if strings.TrimSpace(runtimeID) == "" {
		return errors.New("local runtime identity is unavailable for lease recovery")
	}

	body, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/leases/acquire", d.apiBaseURL(), spaceID), mustJSON(map[string]any{
		"holderKind":      "local_agent",
		"holderId":        expectedHolderID,
		"runtimeId":       runtimeID,
		"replicaId":       permit.ReplicaID,
		"baseSnapshotId":  nullableString(permit.BaseSnapshotID),
		"durationSeconds": 30,
		"recovery":        true,
	}), 2*1024*1024)
	if err != nil {
		return fmt.Errorf("local runtime lease recovery acquire failed: %w", err)
	}
	var response struct {
		SpaceID        string `json:"spaceId"`
		HolderKind     string `json:"holderKind"`
		HolderID       string `json:"holderId"`
		Epoch          int64  `json:"epoch"`
		BaseSnapshotID string `json:"baseSnapshotId"`
		ExpiresAt      string `json:"expiresAt"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return fmt.Errorf("local runtime lease recovery response is invalid: %w", err)
	}
	if response.SpaceID != spaceID || response.HolderKind != "local_agent" || response.HolderID != expectedHolderID || response.Epoch != permit.LeaseEpoch || response.BaseSnapshotID != permit.BaseSnapshotID {
		return errors.New("local runtime lease recovery response does not match the permit")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(response.ExpiresAt))
	if err != nil || !expiresAt.After(time.Now().UTC()) {
		return errors.New("local runtime lease recovery response has an invalid expiry")
	}
	if permit.Status == "prepared" {
		if err := d.state.PutPermit(permit.ExecutionAttemptID, permit.SpaceID, permit.ReplicaID, runtimeID, permit.BaseSnapshotID, permit.LeaseEpoch, expiresAt, "local_agent", expectedHolderID); err != nil {
			return fmt.Errorf("refresh prepared local runtime permit after recovery: %w", err)
		}
	} else if err := d.state.RenewLocalRuntimePermit(permit.ExecutionAttemptID, permit.SpaceID, permit.ReplicaID, runtimeID, permit.BaseSnapshotID, permit.LeaseEpoch, expiresAt); err != nil {
		return fmt.Errorf("refresh consumed local runtime permit after recovery: %w", err)
	}
	return nil
}

func (d *Daemon) startLocalRuntimeLeaseHeartbeat(ctx context.Context, spaceID string, permit *PermitContext) (*localRuntimeLeaseHeartbeat, error) {
	if permit == nil || permit.HolderKind != "local_agent" {
		return &localRuntimeLeaseHeartbeat{stop: func() {}, check: func() error { return nil }}, nil
	}
	if strings.TrimSpace(spaceID) == "" || strings.TrimSpace(permit.SpaceID) != strings.TrimSpace(spaceID) || strings.TrimSpace(permit.ExecutionAttemptID) == "" || strings.TrimSpace(permit.ReplicaID) == "" || permit.LeaseEpoch < 1 {
		return nil, errors.New("local runtime execution permit identity is invalid")
	}
	if permit.Status == "prepared" {
		if permit.HolderID != permit.ExecutionAttemptID {
			return nil, errors.New("prepared local runtime execution permit holder is invalid")
		}
	} else if permit.Status == "active" || permit.Status == "expired" {
		if permit.HolderID != localRuntimePermitHolderID(permit.ExecutionAttemptID) {
			return nil, errors.New("consumed local runtime execution permit holder is invalid")
		}
	} else {
		return nil, fmt.Errorf("local runtime execution permit is already %s", permit.Status)
	}
	runtimeID, err := runtimeIDForPermit(permit)
	if err != nil {
		return nil, err
	}
	heartbeat := func(heartbeatCtx context.Context) error {
		body, err := d.request(heartbeatCtx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/leases/heartbeat", d.apiBaseURL(), spaceID), mustJSON(map[string]any{
			"holderKind":      permit.HolderKind,
			"holderId":        serverPermitHolderID(permit.HolderID),
			"runtimeId":       runtimeID,
			"epoch":           permit.LeaseEpoch,
			"durationSeconds": 30,
		}), 2*1024*1024)
		if err != nil {
			return err
		}
		var response struct {
			ExpiresAt string `json:"expiresAt"`
		}
		if err := json.Unmarshal(body, &response); err != nil {
			return err
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, response.ExpiresAt)
		if err != nil || !expiresAt.After(time.Now().UTC()) {
			return errors.New("local runtime workspace lease heartbeat response is invalid")
		}
		if permit.Status == "prepared" {
			return d.state.PutPermit(permit.ExecutionAttemptID, permit.SpaceID, permit.ReplicaID, runtimeID, permit.BaseSnapshotID, permit.LeaseEpoch, expiresAt, "local_agent", permit.ExecutionAttemptID)
		}
		return d.state.UpdatePermitExpiry(permit.ExecutionAttemptID, expiresAt)
	}
	errCh := make(chan error, 1)
	if err := heartbeat(ctx); err != nil {
		// A host-reaped terminal spool may outlive the online lease. Re-open
		// only the original lease, at the original epoch, then retry the
		// heartbeat; any takeover makes recovery fail closed and leaves the
		// spool available for a later safe retry.
		if recoveryErr := d.recoverLocalRuntimeLease(ctx, spaceID, permit, runtimeID); recoveryErr != nil {
			return nil, fmt.Errorf("local runtime workspace lease heartbeat failed: %w (recovery failed: %v)", err, recoveryErr)
		}
		if retryErr := heartbeat(ctx); retryErr != nil {
			return nil, fmt.Errorf("local runtime workspace lease heartbeat failed after recovery: %w", retryErr)
		}
	}

	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	recordHeartbeatError := func(err error) {
		select {
		case errCh <- err:
		default:
		}
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-ticker.C:
				if err := heartbeat(heartbeatCtx); err != nil {
					if heartbeatCtx.Err() == nil {
						recordHeartbeatError(err)
					}
					return
				}
			}
		}
	}()
	var heartbeatErr error
	var heartbeatErrMu sync.Mutex
	check := func() error {
		heartbeatErrMu.Lock()
		defer heartbeatErrMu.Unlock()
		if heartbeatErr != nil {
			return heartbeatErr
		}
		select {
		case heartbeatErr = <-errCh:
		default:
		}
		return heartbeatErr
	}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			cancel()
			<-done
		})
	}
	return &localRuntimeLeaseHeartbeat{stop: stop, check: check}, nil
}

func (d *Daemon) finalizeExecutionWorkspace(ctx context.Context, spaceID, replicaID, executionAttemptID string) error {
	if executionAttemptID == "" {
		return nil
	}
	permit, err := d.state.PermitContext(executionAttemptID)
	if err != nil {
		return err
	}
	if permit == nil || permit.SpaceID != spaceID || permit.ReplicaID != replicaID {
		return errors.New("local execution permit is unavailable for workspace finalization")
	}
	if permit.Status == "completed" {
		return nil
	}
	if permit.Status != "prepared" && permit.Status != "active" && !(permit.Status == "expired" && isLocalRuntimePermit(permit.HolderID)) {
		return errors.New("local execution permit is unavailable for workspace finalization")
	}
	leaseHeartbeat, err := d.startLocalRuntimeLeaseHeartbeat(ctx, spaceID, permit)
	if err != nil {
		return err
	}
	defer leaseHeartbeat.stop()
	checkLeaseHeartbeat := func() error {
		if heartbeatErr := leaseHeartbeat.check(); heartbeatErr != nil {
			return fmt.Errorf("local runtime workspace lease heartbeat failed: %w", heartbeatErr)
		}
		return nil
	}
	// Check immediately after starting the heartbeat and before reading any
	// state or making a mutating API call. The first heartbeat can race lease
	// expiry, and finalization must fail closed in that case.
	if err := checkLeaseHeartbeat(); err != nil {
		return err
	}
	replica, err := d.state.ReplicaForSpace(spaceID)
	if err != nil {
		return err
	}
	if replica == nil || replica.ReplicaID != replicaID {
		return errors.New("local workspace replica is unavailable for finalization")
	}
	stateBody, err := d.getJSON(ctx, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/state", d.apiBaseURL(), spaceID, replicaID))
	if err != nil {
		return err
	}
	var state remoteReplicaState
	if err := json.Unmarshal(stateBody, &state); err != nil {
		return err
	}
	if err := checkLeaseHeartbeat(); err != nil {
		return err
	}
	if err := d.state.UpdateReplicaPolicy(spaceID, state.WorkspacePolicy.PolicyVersion, state.IntegrationPolicy.IntegrationPolicyVersion); err != nil {
		return err
	}
	replica.PolicyVersion = state.WorkspacePolicy.PolicyVersion
	replica.IntegrationPolicyVersion = state.IntegrationPolicy.IntegrationPolicyVersion
	runtimeID, err := runtimeIDForPermitState(permit, state)
	if err != nil {
		return err
	}
	registerPayload := mustJSON(map[string]any{
		"leaseEpoch":               permit.LeaseEpoch,
		"baseSnapshotId":           nullableString(permit.BaseSnapshotID),
		"runtimeId":                runtimeID,
		"integrationPolicyVersion": replica.IntegrationPolicyVersion,
	})
	if err := checkLeaseHeartbeat(); err != nil {
		return err
	}
	registerBody, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/attempts/%s/register", d.apiBaseURL(), spaceID, replicaID, executionAttemptID), registerPayload, 2*1024*1024)
	if err != nil {
		return err
	}
	var registered struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(registerBody, &registered); err != nil || registered.Status == "" {
		return errors.New("execution attempt registration response is invalid")
	}
	if err := checkLeaseHeartbeat(); err != nil {
		return err
	}
	if err := d.uploadLocalCandidate(ctx, replica, state, executionAttemptID); err != nil {
		return err
	}
	if err := checkLeaseHeartbeat(); err != nil {
		return err
	}
	leaseHeartbeat.stop()
	return d.releaseExecutionPermit(ctx, spaceID, executionAttemptID)
}

func (d *Daemon) activePermit(spaceID string) (string, string, bool, error) {
	row, err := d.state.db.Query(`SELECT space_id, replica_id, expires_at, holder_id, status FROM permits WHERE space_id = ? AND status IN ('prepared', 'active')`, spaceID)
	if err != nil {
		return "", "", false, err
	}
	defer row.Close()
	var storedSpace, replicaID string
	valid := false
	var expiredLocalRuntimeAttemptIDs []string
	for row.Next() {
		var currentSpace, currentReplica, expires, holderID, status string
		if err := row.Scan(&currentSpace, &currentReplica, &expires, &holderID, &status); err != nil {
			return "", "", false, err
		}
		if storedSpace == "" {
			storedSpace, replicaID = currentSpace, currentReplica
		}
		parsed, parseErr := time.Parse(time.RFC3339Nano, expires)
		if parseErr != nil {
			return currentSpace, currentReplica, false, parseErr
		}
		if parsed.After(time.Now().UTC()) {
			valid = true
			if status == "active" && isLocalRuntimePermit(holderID) {
				return currentSpace, currentReplica, true, nil
			}
		} else if status == "active" && isLocalRuntimePermit(holderID) {
			expiredLocalRuntimeAttemptIDs = append(expiredLocalRuntimeAttemptIDs, serverPermitHolderID(holderID))
		}
	}
	if err := row.Err(); err != nil {
		return storedSpace, replicaID, false, err
	}
	if err := row.Close(); err != nil {
		return storedSpace, replicaID, false, err
	}
	for _, attemptID := range expiredLocalRuntimeAttemptIDs {
		if _, err := d.state.db.Exec(`UPDATE permits SET status = 'expired' WHERE execution_attempt_id = ? AND status = 'active'`, attemptID); err != nil {
			return storedSpace, replicaID, false, err
		}
	}
	return storedSpace, replicaID, valid, nil
}

func candidateProvenance(replica *ReplicaState, state remoteReplicaState) (baseCanonical, source string) {
	baseCanonical = replica.AppliedSnapshotID
	source = "watcher"
	if replica.AppliedSnapshotID == "" && replica.InitialChoice == "merge" {
		return "", "initial_merge"
	}
	if replica.AppliedSnapshotID == "" {
		return state.Workspace.CanonicalSnapshotID, "initial_use_local"
	}
	return baseCanonical, source
}

func (d *Daemon) uploadLocalCandidate(ctx context.Context, replica *ReplicaState, state remoteReplicaState, executionAttemptID string) error {
	if replica == nil {
		return nil
	}
	if state.IntegrationPolicy.WorkspaceMode == "one_way_to_local" {
		return errors.New("local workspace upload is disabled by one-way-to-local policy")
	}
	initialUpload := replica.AppliedSnapshotID == ""
	if initialUpload && replica.InitialChoice != "use-local" && replica.InitialChoice != "merge" {
		return errors.New("initial local upload requires use-local or merge")
	}
	policy := scanPolicyFromRemote(state)
	scan, err := ScanWorkspace(replica.Root, policy)
	if err != nil {
		return err
	}
	storedTreeHash, err := storedManifestTreeHash(replica.Manifest)
	if err != nil {
		return err
	}
	if scan.TreeHash == storedTreeHash && replica.CandidateSnapshotID == "" && executionAttemptID == "" {
		return nil
	}
	if replica.CandidateSnapshotID != "" && replica.CandidateTreeHash != scan.TreeHash {
		return errors.New("workspace changed after a candidate was recorded; explicit candidate resolution is required")
	}
	if replica.CandidateSnapshotID != "" && replica.CandidateTreeHash == scan.TreeHash && state.Replica.CurrentSnapshot == replica.CandidateSnapshotID {
		return nil
	}
	snapshotID := replica.CandidateSnapshotID
	if snapshotID == "" {
		snapshotID = uuid.NewString()
	}
	baseCanonical, source := candidateProvenance(replica, state)
	if replica.CandidateSnapshotID != "" {
		if replica.CandidateSource == "" {
			return errors.New("workspace candidate provenance is missing; explicit re-attach is required")
		}
		baseCanonical = replica.CandidateBaseSnapshotID
		source = replica.CandidateSource
	}
	replicaGeneration := replica.CandidateGeneration
	if snapshotID != replica.CandidateSnapshotID || replicaGeneration <= 0 {
		replicaGeneration = time.Now().UTC().UnixMilli()
		if replicaGeneration <= replica.Generation {
			replicaGeneration = replica.Generation + 1
		}
	}
	// Record the local candidate before the first network call. This closes the
	// crash window between a server prepare and local durable association.
	if replica.CandidateSnapshotID == "" {
		if err := d.state.SetReplicaCandidate(replica.SpaceID, snapshotID, scan.TreeHash, replicaGeneration, scan.ManifestBytes, baseCanonical, source); err != nil {
			return err
		}
		replica.CandidateSnapshotID = snapshotID
		replica.CandidateTreeHash = scan.TreeHash
		replica.CandidateGeneration = replicaGeneration
		replica.CandidateManifest = scan.ManifestBytes
		replica.CandidateBaseSnapshotID = baseCanonical
		replica.CandidateSource = source
	}
	// Three-way reconcile must start from the snapshot actually applied to the
	// local tree. Using the server's newer canonical pointer here would erase
	// the evidence of concurrent cloud changes. Initial merge deliberately has
	// no common base; initial use-local explicitly treats cloud as the base.
	var leaseEpoch any
	runtimeID := ""
	if executionAttemptID != "" {
		permit, permitErr := d.state.PermitContext(executionAttemptID)
		if permitErr != nil {
			return permitErr
		}
		if permit == nil || permit.SpaceID != replica.SpaceID || permit.ReplicaID != replica.ReplicaID || permit.LeaseEpoch <= 0 {
			return errors.New("execution attempt has no valid local lease provenance")
		}
		runtimeID, err = runtimeIDForPermitState(permit, state)
		if err != nil {
			return err
		}
		leaseEpoch = permit.LeaseEpoch
	}
	requestBody := mustJSON(map[string]any{
		"snapshotId":              snapshotID,
		"replicaGeneration":       replicaGeneration,
		"parentSnapshotId":        nullableString(replica.AppliedSnapshotID),
		"baseCanonicalSnapshotId": nullableString(baseCanonical),
		"executionAttemptId":      nullableString(executionAttemptID),
		"runtimeId":               nullableString(runtimeID),
		"leaseEpoch":              leaseEpoch,
		"source":                  source,
		"manifest":                scan.Manifest,
		"manifestSha256":          scan.ManifestSHA256,
		"manifestTransportSha256": scan.ManifestSHA256,
		"manifestTransportBytes":  len(scan.ManifestBytes),
		"blobs":                   scan.Blobs,
	})
	prepareBody, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/snapshots/prepare", d.apiBaseURL(), replica.SpaceID, replica.ReplicaID), requestBody, 16*1024*1024)
	if err != nil {
		return err
	}
	var prepared snapshotPrepareResponse
	if err := json.Unmarshal(prepareBody, &prepared); err != nil {
		return fmt.Errorf("decode snapshot prepare response: %w", err)
	}
	if prepared.SnapshotID != snapshotID {
		return errors.New("snapshot prepare returned an unexpected identity")
	}
	if !prepared.ManifestInline {
		if prepared.ManifestUpload == nil || prepared.ManifestUpload.UploadURL == "" {
			return errors.New("snapshot prepare did not return a manifest upload URL")
		}
		if err := d.putSignedBytes(ctx, prepared.ManifestUpload.UploadURL, prepared.ManifestUpload.Headers, scan.ManifestBytes); err != nil {
			return fmt.Errorf("upload workspace manifest: %w", err)
		}
	}
	blobPathByHash := make(map[string]string, len(scan.Blobs))
	for _, blob := range scan.Blobs {
		blobPathByHash[blob.SHA256] = blob.Path
	}
	for _, blob := range prepared.Blobs {
		if blob.Ready {
			continue
		}
		path := blobPathByHash[blob.SHA256]
		if path == "" || blob.UploadURL == "" {
			return fmt.Errorf("snapshot prepare omitted upload data for blob %s", blob.SHA256)
		}
		if err := d.putSignedFile(ctx, blob.UploadURL, blob.Headers, targetPathForReplica(replica.Root, path), blob.Size, blob.SHA256); err != nil {
			return fmt.Errorf("upload workspace blob %s: %w", path, err)
		}
	}
	commitBody, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/snapshots/%s/commit", d.apiBaseURL(), replica.SpaceID, replica.ReplicaID, snapshotID), mustJSON(map[string]any{"runtimeId": nullableString(runtimeID)}), 2*1024*1024)
	if err != nil {
		return err
	}
	var committed snapshotCommitResponse
	if err := json.Unmarshal(commitBody, &committed); err != nil {
		return fmt.Errorf("decode snapshot commit response: %w", err)
	}
	if committed.SnapshotID != snapshotID || committed.TreeHash != scan.TreeHash {
		return errors.New("snapshot commit response does not match the uploaded candidate")
	}
	return nil
}

func storedManifestTreeHash(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return "", fmt.Errorf("decode local manifest cache: %w", err)
	}
	treeRaw, err := json.Marshal(map[string]any{
		"scanPolicyHash":   manifest["scanPolicyHash"],
		"entries":          manifest["entries"],
		"boundaries":       manifest["boundaries"],
		"portableGitState": manifest["portableGitState"],
	})
	if err != nil {
		return "", err
	}
	hash, _, err := CanonicalHash(treeRaw)
	return hash, err
}

func (d *Daemon) prepareCanonicalPull(replica *ReplicaState, state remoteReplicaState) (canonicalPullPreparation, error) {
	current, err := ScanWorkspace(replica.Root, scanPolicyFromRemote(state))
	if err != nil {
		return canonicalPullPreparation{}, err
	}
	storedTreeHash, err := storedManifestTreeHash(replica.Manifest)
	if err != nil {
		return canonicalPullPreparation{}, err
	}
	if current.TreeHash == storedTreeHash {
		return canonicalPullPreparation{}, nil
	}
	switch state.IntegrationPolicy.WorkspaceMode {
	case "two_way_safe", "one_way_to_cloud":
		return canonicalPullPreparation{uploadLocal: true}, nil
	case "one_way_to_local":
		if _, err := d.createInitialRecoveryBackup(replica, current); err != nil {
			return canonicalPullPreparation{}, fmt.Errorf("create one-way-to-local recovery backup: %w", err)
		}
		replica.Manifest = current.ManifestBytes
		return canonicalPullPreparation{allowDestructive: true}, nil
	default:
		return canonicalPullPreparation{}, fmt.Errorf("workspace mode is unsupported: %s", state.IntegrationPolicy.WorkspaceMode)
	}
}

func (d *Daemon) putSignedBytes(ctx context.Context, url string, headers map[string]string, body []byte) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.ContentLength = int64(len(body))
	applySignedHeaders(request, headers)
	response, err := d.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("object PUT returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (d *Daemon) putSignedFile(ctx context.Context, url string, headers map[string]string, path string, expectedSize int64, expectedHash string) error {
	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() != expectedSize {
		return errors.New("file changed after scan")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, io.TeeReader(file, hash))
	if err != nil {
		return err
	}
	request.ContentLength = expectedSize
	applySignedHeaders(request, headers)
	response, err := d.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("object PUT returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	after, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !sameFileIdentity(before, after) || hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		return errors.New("file changed during upload")
	}
	return nil
}

func applySignedHeaders(request *http.Request, headers map[string]string) {
	for name, value := range headers {
		if strings.EqualFold(name, "content-length") {
			continue
		}
		request.Header.Set(name, value)
	}
}

func (d *Daemon) resolveManifest(ctx context.Context, snapshot remoteSnapshot) ([]byte, error) {
	if len(snapshot.Manifest) > 0 && string(snapshot.Manifest) != "null" {
		return snapshot.Manifest, nil
	}
	if snapshot.ManifestDownload == nil || snapshot.ManifestDownload.DownloadURL == "" {
		return nil, errors.New("remote workspace snapshot has no manifest")
	}
	return d.download(ctx, snapshot.ManifestDownload.DownloadURL, syncManifestMaxBytes, "", 0)
}

// Preserve manifest field presence while hashing. Re-encoding remoteEntry would
// drop semantically meaningful false values such as executable=false.
func remoteManifestTreeHash(raw []byte) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", err
	}
	for _, key := range []string{"scanPolicyHash", "entries"} {
		if len(fields[key]) == 0 {
			return "", fmt.Errorf("remote manifest is missing %s", key)
		}
	}
	boundaries := fields["boundaries"]
	if len(boundaries) == 0 {
		boundaries = json.RawMessage(`[]`)
	}
	portableGitState := fields["portableGitState"]
	if len(portableGitState) == 0 {
		portableGitState = json.RawMessage(`null`)
	}
	treeRaw, err := json.Marshal(map[string]json.RawMessage{
		"scanPolicyHash":   fields["scanPolicyHash"],
		"entries":          fields["entries"],
		"boundaries":       boundaries,
		"portableGitState": portableGitState,
	})
	if err != nil {
		return "", err
	}
	hash, _, err := CanonicalHash(treeRaw)
	return hash, err
}

func (d *Daemon) refreshAccessToken(ctx context.Context) error {
	deviceID, credentialErr := LoadCredential(credentialDeviceID)
	if credentialErr != nil || strings.TrimSpace(deviceID) == "" {
		deviceID = strings.TrimSpace(d.cfg.DeviceID)
	}
	if strings.TrimSpace(deviceID) == "" {
		return errors.New("local agent device id is unavailable")
	}
	refreshToken, refreshErr := LoadCredential(credentialRefreshToken)
	if refreshErr != nil || strings.TrimSpace(refreshToken) == "" {
		refreshToken = strings.TrimSpace(d.cfg.RefreshToken)
	}
	if strings.TrimSpace(refreshToken) == "" {
		return errors.New("local agent refresh credential is unavailable")
	}
	if d.apiBaseURL() == "" {
		return errors.New("COHUB_API_URL is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/devices/%s/token", d.apiBaseURL(), deviceID), bytes.NewReader(mustJSON(map[string]any{"refreshToken": refreshToken})))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := d.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("local agent token refresh returned HTTP %d", response.StatusCode)
	}
	var result struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(body, &result); err != nil || strings.TrimSpace(result.AccessToken) == "" {
		return errors.New("local agent token refresh response is invalid")
	}
	if err := SaveCredential(credentialAccessToken, result.AccessToken); err != nil {
		return err
	}
	d.setAccessToken(result.AccessToken)
	return nil
}

func (d *Daemon) getJSON(ctx context.Context, url string) ([]byte, error) {
	return d.request(ctx, http.MethodGet, url, nil, 4*1024*1024)
}

func (d *Daemon) request(ctx context.Context, method, url string, body []byte, maxBytes int64) ([]byte, error) {
	if d.apiBaseURL() == "" {
		return nil, errors.New("COHUB_API_URL is not configured")
	}
	token, err := d.accessToken()
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response, err := d.client.Do(request)
		if err != nil {
			return nil, err
		}
		result, readErr := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		if int64(len(result)) > maxBytes {
			return nil, errors.New("remote response exceeds the configured limit")
		}
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			if refreshErr := d.refreshAccessToken(ctx); refreshErr != nil {
				return nil, refreshErr
			}
			token, err = d.accessToken()
			if err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, fmt.Errorf("local agent API returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(result)))
		}
		return result, nil
	}
	return nil, errors.New("local agent API request failed")
}

func (d *Daemon) download(ctx context.Context, url string, maxBytes int64, expectedHash string, expectedSize int64) ([]byte, error) {
	if url == "" {
		return nil, errors.New("download URL is empty")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := d.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("object download returned HTTP %d", response.StatusCode)
	}
	result, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(result)) > maxBytes {
		return nil, errors.New("download exceeds the configured limit")
	}
	if expectedSize > 0 && int64(len(result)) != expectedSize {
		return nil, errors.New("download size does not match the manifest")
	}
	if expectedHash != "" {
		digest := sha256.Sum256(result)
		if hex.EncodeToString(digest[:]) != expectedHash {
			return nil, errors.New("download hash does not match the manifest")
		}
	}
	return result, nil
}

// downloadToFile streams an object to path, verifying size and SHA-256 as the
// bytes arrive. The file is fsynced and left in place only when verification
// succeeds; any failure removes the partial file.
func (d *Daemon) downloadToFile(ctx context.Context, url, path string, expectedSize int64, expectedHash string, mode os.FileMode) (returnErr error) {
	if url == "" {
		return errors.New("download URL is empty")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := d.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("object download returned HTTP %d", response.StatusCode)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer func() {
		if returnErr != nil {
			_ = file.Close()
			_ = os.Remove(path)
		}
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, expectedSize+1))
	if err != nil {
		return err
	}
	if written != expectedSize {
		return errors.New("download size does not match the manifest")
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		return errors.New("download hash does not match the manifest")
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return file.Close()
}

func validateRemoteApplyPrecondition(state remoteReplicaState, snapshotID string, generation int64, now time.Time) error {
	canonicalID := state.Workspace.CanonicalSnapshotID
	if canonicalID == "" {
		canonicalID = state.Replica.CanonicalSnapshot
	}
	if canonicalID != snapshotID || state.Workspace.Generation != generation {
		return fmt.Errorf("canonical workspace state changed before apply: expected snapshot %s generation %d, got snapshot %s generation %d", snapshotID, generation, canonicalID, state.Workspace.Generation)
	}
	if state.Lease == nil {
		return nil
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, state.Lease.ExpiresAt)
	if err != nil {
		return fmt.Errorf("workspace writer lease expiry is invalid: %w", err)
	}
	if expiresAt.After(now.UTC()) {
		return errors.New("workspace has an active server writer lease")
	}
	return nil
}

func (d *Daemon) validateRemoteApplyState(ctx context.Context, spaceID, replicaID, snapshotID string, generation int64) error {
	body, err := d.getJSON(ctx, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/state", d.apiBaseURL(), spaceID, replicaID))
	if err != nil {
		return err
	}
	var state remoteReplicaState
	if err := json.Unmarshal(body, &state); err != nil {
		return err
	}
	return validateRemoteApplyPrecondition(state, snapshotID, generation, time.Now())
}

func (d *Daemon) applyRemoteSnapshot(ctx context.Context, replica *ReplicaState, manifest remoteManifest, blobs map[string]struct {
	sha256 string
	size   int64
	url    string
}, snapshotID string, generation int64, expectedTreeHash string, policy remoteReplicaStateWorkspacePolicy, rawManifest []byte, allowDestructive bool) (returnErr error) {
	oldManifest := replica.Manifest
	if replica.CandidateSnapshotID != "" && len(replica.CandidateManifest) > 0 {
		oldManifest = replica.CandidateManifest
	}
	old, err := parseStoredManifest(oldManifest)
	if err != nil {
		return err
	}
	// Resolve and validate every destination, old and new, before any byte on
	// disk changes. A malformed path anywhere in the manifest aborts the apply
	// as a whole instead of after some removals already happened.
	newByPath := make(map[string]remoteEntry, len(manifest.Entries))
	destinations := make(map[string]string, len(manifest.Entries)+len(old))
	for _, entry := range manifest.Entries {
		destination, err := targetPathForReplicaChecked(replica.Root, entry.Path)
		if err != nil {
			return fmt.Errorf("remote manifest contains an unsafe path %q: %w", entry.Path, err)
		}
		if entry.Type == "symlink" && !safeRelativeSymlink(replica.Root, destination, entry.SymlinkTarget) {
			return fmt.Errorf("unsafe remote symlink: %s", entry.Path)
		}
		destinations[entry.Path] = destination
		newByPath[entry.Path] = entry
		if entry.Type == "file" {
			blob, ok := blobs[entry.Path]
			if !ok || blob.sha256 != entry.SHA256 || blob.size != entry.Size || blob.url == "" {
				return fmt.Errorf("remote manifest has no verified blob for %s", entry.Path)
			}
		}
	}
	oldByPath := make(map[string]remoteEntry, len(old))
	for _, entry := range old {
		if _, known := destinations[entry.Path]; !known {
			destination, err := targetPathForReplicaChecked(replica.Root, entry.Path)
			if err != nil {
				return fmt.Errorf("local manifest cache contains an unsafe path %q: %w", entry.Path, err)
			}
			destinations[entry.Path] = destination
		}
		oldByPath[entry.Path] = entry
	}
	deletePaths := remoteManifestDeletionPaths(oldByPath, newByPath, manifest.Omitted)
	deletions := len(deletePaths)
	if !allowDestructive && (deletions > 1000 || (len(oldByPath) > 0 && float64(deletions)/float64(len(oldByPath)) > 0.2)) {
		return errors.New("remote workspace deletion threshold requires explicit confirmation")
	}
	affectedPaths := make([]string, 0, len(manifest.Entries)+deletions)
	for _, entry := range manifest.Entries {
		if prior, ok := oldByPath[entry.Path]; !ok || !sameEntry(prior, entry) {
			affectedPaths = append(affectedPaths, entry.Path)
		}
	}
	affectedPaths = append(affectedPaths, deletePaths...)
	cycleID := fmt.Sprintf("pull-%s-%d", snapshotID, generation)
	staging := filepath.Join(d.cfg.DataDir, "staging", cycleID)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	// Download every new/changed file into staging before mutating the
	// workspace. Files stream to disk and are hashed on the way, so a large
	// blob never has to fit in memory and a network failure leaves the tree
	// untouched.
	stagedFiles := make(map[string]string)
	for _, entry := range manifest.Entries {
		if entry.Type != "file" {
			continue
		}
		if prior, ok := oldByPath[entry.Path]; ok && prior.Type == "file" && prior.SHA256 == entry.SHA256 && prior.Size == entry.Size && prior.Executable == entry.Executable {
			continue
		}
		blob := blobs[entry.Path]
		temporary := filepath.Join(staging, "files", filepath.FromSlash(entry.Path))
		if err := os.MkdirAll(filepath.Dir(temporary), 0o700); err != nil {
			return err
		}
		mode := os.FileMode(0o664)
		if entry.Executable {
			mode = 0o775
		}
		if err := d.downloadToFile(ctx, blob.url, temporary, entry.Size, entry.SHA256, mode); err != nil {
			return fmt.Errorf("download %s: %w", entry.Path, err)
		}
		stagedFiles[entry.Path] = temporary
	}
	replacements := make(map[string]localFileReplacement, len(stagedFiles))
	replacementPaths := make(map[string]struct{}, len(stagedFiles))
	for path, source := range stagedFiles {
		entry := newByPath[path]
		mode := os.FileMode(0o664)
		if entry.Executable {
			mode = 0o775
		}
		replacement, err := newLocalFileReplacement(replica.Root, cycleID, path, source, destinations[path], entry.Size, entry.SHA256, mode)
		if err != nil {
			return fmt.Errorf("prepare local replacement for %s: %w", path, err)
		}
		if _, managed := destinations[replacement.journalPath]; managed {
			return fmt.Errorf("local replacement path conflicts with managed workspace path: %s", replacement.journalPath)
		}
		if _, duplicate := replacementPaths[replacement.journalPath]; duplicate {
			return fmt.Errorf("local replacement path collision: %s", replacement.journalPath)
		}
		replacementPaths[replacement.journalPath] = struct{}{}
		affectedPaths = append(affectedPaths, replacement.journalPath)
		replacements[path] = replacement
	}
	if _, err := os.Stat(filepath.Join(replica.Root, ".cohub", "system")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// A simple process-local apply lock prevents two daemon sync ticks from
	// interleaving. Provider preflight permits are checked again immediately
	// before the first mutation.
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.validateRemoteApplyState(ctx, replica.SpaceID, replica.ReplicaID, snapshotID, generation); err != nil {
		return err
	}
	if _, _, valid, err := d.activePermit(replica.SpaceID); err != nil {
		return err
	} else if valid {
		return errors.New("workspace has an active local execution permit")
	}
	journal, err := createLocalApplyJournal(d.state, d.cfg.DataDir, replica.Root, cycleID, affectedPaths)
	if err != nil {
		return err
	}
	journalCommitted := false
	defer func() {
		if journalCommitted {
			return
		}
		if err := journal.Rollback(); err != nil {
			if returnErr == nil {
				returnErr = fmt.Errorf("rollback local workspace apply: %w", err)
			}
			return
		}
		if err := journal.Cleanup(); err != nil && returnErr == nil {
			returnErr = fmt.Errorf("cleanup local workspace apply journal: %w", err)
		}
	}()
	// Clear every path whose entry changed, including type changes such as a
	// file becoming a directory, so the create pass below starts from a clean
	// slot. Unchanged directories are left alone to preserve their children.
	for _, entry := range sortedEntries(manifest.Entries, true) {
		prior, existed := oldByPath[entry.Path]
		if !existed || sameEntry(prior, entry) {
			continue
		}
		if entry.Type == "directory" && prior.Type == "directory" {
			continue
		}
		if err := removeReplicaPathChecked(replica.Root, entry.Path); err != nil {
			return err
		}
	}
	for _, entry := range sortedEntries(manifest.Entries, false) {
		switch entry.Type {
		case "directory":
			if err := mkdirAllReplicaPathChecked(replica.Root, entry.Path, 0o775); err != nil {
				return err
			}
		case "symlink":
			if prior, ok := oldByPath[entry.Path]; ok && sameEntry(prior, entry) {
				continue
			}
			if err := mkdirAllReplicaPathParentChecked(replica.Root, entry.Path, 0o775); err != nil {
				return err
			}
			if err := symlinkReplicaPathChecked(replica.Root, entry.SymlinkTarget, entry.Path); err != nil {
				return err
			}
		case "file":
			replacement, changed := replacements[entry.Path]
			if !changed {
				continue
			}
			if err := replacement.install(); err != nil {
				return fmt.Errorf("replace local file %s: %w", entry.Path, err)
			}
		}
	}
	sort.Slice(deletePaths, func(i, j int) bool { return len(deletePaths[i]) > len(deletePaths[j]) })
	for _, path := range deletePaths {
		if err := removeReplicaPathChecked(replica.Root, path); err != nil {
			return err
		}
	}
	verify, err := ScanWorkspace(replica.Root, ScanPolicy{
		PolicyVersion:    manifest.PolicyVersion,
		DefaultExcludes:  policy.DefaultExcludes,
		CustomExcludes:   policy.CustomExcludes,
		SensitiveMode:    policy.SensitiveMode,
		MaxEntries:       intValue(policy.Limits["maxEntries"], 2_000_000),
		MaxFileBytes:     int64Value(policy.Limits["maxFileBytes"], 5*1024*1024*1024),
		MaxSnapshotBytes: int64Value(policy.Limits["maxSnapshotBytes"], 100*1024*1024*1024),
	})
	if err != nil {
		return fmt.Errorf("verify applied workspace: %w", err)
	}
	if verify.TreeHash != expectedTreeHash {
		return fmt.Errorf("applied workspace tree hash mismatch: expected %s, got %s", expectedTreeHash, verify.TreeHash)
	}
	if len(rawManifest) == 0 {
		return errors.New("remote workspace manifest bytes are missing")
	}
	if err := syncReplicaMutationDirectories(replica.Root, affectedPaths); err != nil {
		return fmt.Errorf("sync applied workspace directories: %w", err)
	}
	if err := d.state.SetReplicaAppliedWithJournal(replica.SpaceID, snapshotID, generation, "ready", rawManifest, cycleID); err != nil {
		return err
	}
	journalCommitted = true
	if err := journal.Cleanup(); err != nil {
		return err
	}
	if err := d.ackApplied(ctx, replica, snapshotID, generation); err != nil {
		return err
	}
	return nil
}

type remoteReplicaStateWorkspacePolicy = struct {
	PolicyVersion   int64          `json:"policyVersion"`
	DefaultExcludes []string       `json:"defaultExcludes"`
	CustomExcludes  []string       `json:"customExcludes"`
	SensitiveMode   string         `json:"sensitiveContentMode"`
	Limits          map[string]any `json:"limits"`
}

func parseStoredManifest(raw []byte) ([]remoteEntry, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var manifest remoteManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("decode local manifest cache: %w", err)
	}
	return manifest.Entries, nil
}

func sameEntry(a, b remoteEntry) bool {
	return a.Path == b.Path && a.Type == b.Type && a.Size == b.Size && a.SHA256 == b.SHA256 && a.Executable == b.Executable && a.SymlinkTarget == b.SymlinkTarget
}

func manifestPathOmitted(path string, omitted map[string]struct{}) bool {
	for {
		if _, ok := omitted[path]; ok {
			return true
		}
		separator := strings.LastIndexByte(path, '/')
		if separator < 0 {
			return false
		}
		path = path[:separator]
	}
}

func remoteManifestDeletionPaths(oldByPath, newByPath map[string]remoteEntry, omitted []string) []string {
	omittedPaths := make(map[string]struct{}, len(omitted))
	for _, path := range omitted {
		omittedPaths[path] = struct{}{}
	}
	paths := make([]string, 0)
	for path := range oldByPath {
		if _, exists := newByPath[path]; !exists && !manifestPathOmitted(path, omittedPaths) {
			paths = append(paths, path)
		}
	}
	return paths
}

func candidateApplyIsSafe(candidateRaw, currentRaw []byte, target remoteManifest) error {
	candidate, err := parseStoredManifest(candidateRaw)
	if err != nil {
		return err
	}
	current, err := parseStoredManifest(currentRaw)
	if err != nil {
		return err
	}
	candidateByPath := make(map[string]remoteEntry, len(candidate))
	for _, entry := range candidate {
		candidateByPath[entry.Path] = entry
	}
	currentByPath := make(map[string]remoteEntry, len(current))
	for _, entry := range current {
		currentByPath[entry.Path] = entry
	}
	targetByPath := make(map[string]remoteEntry, len(target.Entries))
	for _, entry := range target.Entries {
		targetByPath[entry.Path] = entry
	}
	paths := make(map[string]struct{}, len(candidateByPath)+len(currentByPath)+len(targetByPath))
	for path := range candidateByPath {
		paths[path] = struct{}{}
	}
	for path := range currentByPath {
		paths[path] = struct{}{}
	}
	for path := range targetByPath {
		paths[path] = struct{}{}
	}
	for path := range paths {
		candidateEntry := candidateByPath[path]
		currentEntry := currentByPath[path]
		targetEntry := targetByPath[path]
		if sameEntry(currentEntry, candidateEntry) || sameEntry(currentEntry, targetEntry) {
			continue
		}
		return fmt.Errorf("workspace changed after candidate resolution at %s; explicit reconciliation is required", path)
	}
	return nil
}

func sortedEntries(entries []remoteEntry, reverse bool) []remoteEntry {
	result := append([]remoteEntry(nil), entries...)
	sort.Slice(result, func(i, j int) bool {
		if reverse {
			return len(result[i].Path) > len(result[j].Path)
		}
		return result[i].Path < result[j].Path
	})
	return result
}

func targetPathForReplica(root, path string) string {
	return filepath.Join(append([]string{root}, filepath.FromSlash(path))...)
}

func targetPathForReplicaChecked(root, path string) (string, error) {
	normalized, err := normalizePath(path)
	if err != nil || normalized != path || filepath.IsAbs(path) || filepath.VolumeName(path) != "" || strings.Contains(path, "\\") {
		return "", errors.New("unsafe workspace path")
	}
	candidate := filepath.Clean(filepath.Join(root, filepath.FromSlash(path)))
	rootClean := filepath.Clean(root)
	rel, err := filepath.Rel(rootClean, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", errors.New("workspace path escapes replica root")
	}
	return candidate, nil
}

func safeRelativeSymlink(root, destination, target string) bool {
	if target == "" || filepath.IsAbs(target) || strings.Contains(target, "\\") {
		return false
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(destination), filepath.FromSlash(target)))
	rel, err := filepath.Rel(filepath.Clean(root), resolved)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func syncFilePath(path string) error {
	file, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
func maxInt64(value, fallback int64) int64 {
	if value > fallback {
		return value
	}
	return fallback
}
func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed < float64(^uint(0)>>1) {
			return int(typed)
		}
	case int:
		if typed > 0 {
			return typed
		}
	}
	return fallback
}
func int64Value(value any, fallback int64) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 {
			return int64(typed)
		}
	case int64:
		if typed > 0 {
			return typed
		}
	}
	return fallback
}

func (d *Daemon) ackApplied(ctx context.Context, replica *ReplicaState, snapshotID string, generation int64) error {
	payload := mustJSON(map[string]any{"generation": generation})
	_, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/snapshots/%s/applied", d.apiBaseURL(), replica.SpaceID, replica.ReplicaID, snapshotID), payload, 2*1024*1024)
	return err
}
