package locald

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const stateSchemaVersion = 4
const acpRuntimePermitHolderPrefix = "acp:"

func acpRuntimePermitHolderID(executionAttemptID string) string {
	return acpRuntimePermitHolderPrefix + executionAttemptID
}

func isAcpRuntimePermit(holderID string) bool {
	return strings.HasPrefix(holderID, acpRuntimePermitHolderPrefix)
}

func serverPermitHolderID(holderID string) string {
	return strings.TrimPrefix(holderID, acpRuntimePermitHolderPrefix)
}

// StateStore contains only local daemon state. It is deliberately not a
// substitute for server authority; spool rows are replayable evidence and
// cache rows can be rebuilt from the server.
type StateStore struct {
	db *sql.DB
	mu sync.Mutex
}

func DefaultDataDir() string {
	if value := os.Getenv("COHUB_LOCALD_DATA_DIR"); value != "" {
		return value
	}
	if runtime.GOOS == "darwin" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "Cohub", "locald")
		}
	}
	if runtime.GOOS == "windows" {
		if value := os.Getenv("LOCALAPPDATA"); value != "" {
			return filepath.Join(value, "Cohub", "locald")
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "cohub", "locald")
	}
	return filepath.Join(os.TempDir(), "cohub-locald")
}

func OpenState(dataDir string) (*StateStore, error) {
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create locald data directory: %w", err)
	}
	dbPath := filepath.Join(dataDir, "state.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open locald state database: %w", err)
	}
	store := &StateStore{db: db}
	if err := store.configure(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := os.Chmod(dbPath, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("secure locald state database: %w", err)
	}
	return store, nil
}

func (s *StateStore) configure() error {
	statements := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA foreign_keys=ON",
		`CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS replicas (
			space_id TEXT PRIMARY KEY,
			replica_id TEXT NOT NULL,
			root TEXT NOT NULL,
			root_fingerprint TEXT NOT NULL,
			device_id TEXT NOT NULL,
			policy_version INTEGER NOT NULL,
			integration_policy_version INTEGER NOT NULL,
			canonical_snapshot_id TEXT,
			applied_snapshot_id TEXT,
			generation INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'attaching',
			manifest BLOB,
			candidate_snapshot_id TEXT,
			candidate_tree_hash TEXT,
			candidate_generation INTEGER,
			candidate_manifest BLOB,
			candidate_base_snapshot_id TEXT,
			candidate_source TEXT,
			initial_choice TEXT,
			updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS replicas_root_identity ON replicas(root_fingerprint)`,
		`CREATE TABLE IF NOT EXISTS spool (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			payload BLOB NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempt_count INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS spool_pending_idx ON spool(status, next_attempt_at, sequence)`,
		`CREATE TABLE IF NOT EXISTS permits (
			execution_attempt_id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			replica_id TEXT NOT NULL,
			base_snapshot_id TEXT,
			lease_epoch INTEGER,
			expires_at TEXT NOT NULL,
			holder_kind TEXT NOT NULL DEFAULT 'local_agent',
			holder_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'prepared',
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS applied_journal (
			cycle_id TEXT PRIMARY KEY,
			root TEXT NOT NULL,
			journal_path TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("initialize locald state: %w", err)
		}
	}
	for _, column := range []string{"manifest BLOB", "candidate_snapshot_id TEXT", "candidate_tree_hash TEXT", "candidate_generation INTEGER", "candidate_manifest BLOB", "candidate_base_snapshot_id TEXT", "candidate_source TEXT", "initial_choice TEXT"} {
		if _, err := s.db.Exec(`ALTER TABLE replicas ADD COLUMN ` + column); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
			return fmt.Errorf("upgrade locald replica state: %w", err)
		}
	}
	for _, column := range []string{"holder_kind TEXT NOT NULL DEFAULT 'local_agent'", "holder_id TEXT NOT NULL DEFAULT ''"} {
		if _, err := s.db.Exec(`ALTER TABLE permits ADD COLUMN ` + column); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
			return fmt.Errorf("upgrade locald permit state: %w", err)
		}
	}
	if _, err := s.db.Exec(`INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, stateSchemaVersion); err != nil {
		return fmt.Errorf("write locald schema version: %w", err)
	}
	return nil
}

func (s *StateStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *StateStore) PutMeta(key, value string) error {
	if key == "" {
		return errors.New("meta key is required")
	}
	_, err := s.db.Exec(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *StateStore) GetMeta(key string) (string, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}

type ReplicaState struct {
	SpaceID                  string `json:"spaceId"`
	ReplicaID                string `json:"replicaId"`
	Root                     string `json:"root"`
	RootFingerprint          string `json:"rootFingerprint"`
	DeviceID                 string `json:"deviceId"`
	PolicyVersion            int64  `json:"policyVersion"`
	IntegrationPolicyVersion int64  `json:"integrationPolicyVersion"`
	CanonicalSnapshotID      string `json:"canonicalSnapshotId,omitempty"`
	AppliedSnapshotID        string `json:"appliedSnapshotId,omitempty"`
	Generation               int64  `json:"generation"`
	Status                   string `json:"status"`
	UpdatedAt                string `json:"updatedAt"`
	Manifest                 []byte `json:"-"`
	CandidateSnapshotID      string `json:"candidateSnapshotId,omitempty"`
	CandidateTreeHash        string `json:"candidateTreeHash,omitempty"`
	CandidateGeneration      int64  `json:"candidateGeneration,omitempty"`
	CandidateManifest        []byte `json:"-"`
	CandidateBaseSnapshotID  string `json:"candidateBaseSnapshotId,omitempty"`
	CandidateSource          string `json:"candidateSource,omitempty"`
	InitialChoice            string `json:"initialChoice,omitempty"`
}

func (s *StateStore) AssertReplicaRootAvailable(spaceID, replicaID, root string) error {
	rows, err := s.db.Query(`SELECT space_id, replica_id, root FROM replicas`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var existingSpaceID, existingReplicaID, existingRoot string
		if err := rows.Scan(&existingSpaceID, &existingReplicaID, &existingRoot); err != nil {
			return err
		}
		if existingSpaceID == spaceID && (existingReplicaID == replicaID || filepath.Clean(existingRoot) == filepath.Clean(root)) {
			continue
		}
		if sameOrBelowRoot(existingRoot, root) || sameOrBelowRoot(root, existingRoot) {
			return fmt.Errorf("workspace root overlaps attached replica %s; detach it before attaching this root", existingReplicaID)
		}
	}
	return rows.Err()
}

func (s *StateStore) UpsertReplica(replica ReplicaState) error {
	if replica.SpaceID == "" || replica.ReplicaID == "" || replica.Root == "" || replica.RootFingerprint == "" || replica.DeviceID == "" {
		return errors.New("replica identity is incomplete")
	}
	var existingReplicaID, existingDeviceID, candidateID string
	err := s.db.QueryRow(`SELECT replica_id, device_id, COALESCE(candidate_snapshot_id, '') FROM replicas WHERE space_id = ?`, replica.SpaceID).Scan(&existingReplicaID, &existingDeviceID, &candidateID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	rebinding := err == nil && (existingReplicaID != replica.ReplicaID || existingDeviceID != replica.DeviceID)
	if rebinding && candidateID != "" {
		return errors.New("cannot rebind a replica while a workspace candidate is pending")
	}
	_, err = s.db.Exec(`
		INSERT INTO replicas(space_id, replica_id, root, root_fingerprint, device_id, policy_version, integration_policy_version, canonical_snapshot_id, applied_snapshot_id, generation, status, manifest, candidate_snapshot_id, candidate_tree_hash, candidate_generation, candidate_manifest, candidate_base_snapshot_id, candidate_source, initial_choice, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(space_id) DO UPDATE SET
			replica_id=excluded.replica_id,
			root=excluded.root,
			root_fingerprint=excluded.root_fingerprint,
			device_id=excluded.device_id,
			policy_version=excluded.policy_version,
			integration_policy_version=excluded.integration_policy_version,
			canonical_snapshot_id=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.canonical_snapshot_id ELSE excluded.canonical_snapshot_id END,
			applied_snapshot_id=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.applied_snapshot_id ELSE excluded.applied_snapshot_id END,
			generation=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.generation ELSE excluded.generation END,
			status=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.status ELSE excluded.status END,
			manifest=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.manifest ELSE excluded.manifest END,
			candidate_snapshot_id=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_snapshot_id ELSE excluded.candidate_snapshot_id END,
			candidate_tree_hash=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_tree_hash ELSE excluded.candidate_tree_hash END,
			candidate_generation=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_generation ELSE excluded.candidate_generation END,
			candidate_manifest=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_manifest ELSE excluded.candidate_manifest END,
			candidate_base_snapshot_id=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_base_snapshot_id ELSE excluded.candidate_base_snapshot_id END,
			candidate_source=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN replicas.candidate_source ELSE excluded.candidate_source END,
			initial_choice=CASE WHEN replicas.replica_id=excluded.replica_id AND replicas.device_id=excluded.device_id THEN COALESCE(excluded.initial_choice, replicas.initial_choice) ELSE excluded.initial_choice END,
			updated_at=excluded.updated_at`,
		replica.SpaceID,
		replica.ReplicaID,
		replica.Root,
		replica.RootFingerprint,
		replica.DeviceID,
		replica.PolicyVersion,
		replica.IntegrationPolicyVersion,
		nullString(replica.CanonicalSnapshotID),
		nullString(replica.AppliedSnapshotID),
		replica.Generation,
		replica.Status,
		replica.Manifest,
		nullString(replica.CandidateSnapshotID),
		nullString(replica.CandidateTreeHash),
		nullInt64(replica.CandidateGeneration),
		replica.CandidateManifest,
		nullString(replica.CandidateBaseSnapshotID),
		nullString(replica.CandidateSource),
		nullString(replica.InitialChoice),
		replica.UpdatedAt,
	)
	return err
}

func (s *StateStore) ReplicaForPath(path string) (*ReplicaState, error) {
	rows, err := s.db.Query(`SELECT space_id, replica_id, root, root_fingerprint, device_id, policy_version, integration_policy_version, COALESCE(canonical_snapshot_id, ''), COALESCE(applied_snapshot_id, ''), generation, status, COALESCE(manifest, X''), COALESCE(candidate_snapshot_id, ''), COALESCE(candidate_tree_hash, ''), COALESCE(candidate_generation, 0), COALESCE(candidate_manifest, X''), COALESCE(candidate_base_snapshot_id, ''), COALESCE(candidate_source, ''), COALESCE(initial_choice, ''), updated_at FROM replicas`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var best *ReplicaState
	for rows.Next() {
		var item ReplicaState
		if err := rows.Scan(&item.SpaceID, &item.ReplicaID, &item.Root, &item.RootFingerprint, &item.DeviceID, &item.PolicyVersion, &item.IntegrationPolicyVersion, &item.CanonicalSnapshotID, &item.AppliedSnapshotID, &item.Generation, &item.Status, &item.Manifest, &item.CandidateSnapshotID, &item.CandidateTreeHash, &item.CandidateGeneration, &item.CandidateManifest, &item.CandidateBaseSnapshotID, &item.CandidateSource, &item.InitialChoice, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if sameOrBelowRoot(item.Root, path) && (best == nil || len(item.Root) > len(best.Root)) {
			copy := item
			best = &copy
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return best, nil
}

func sameOrBelowRoot(root, path string) bool {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	if root == path {
		return true
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func (s *StateStore) UpdateReplicaPolicy(spaceID string, policyVersion, integrationPolicyVersion int64) error {
	if spaceID == "" || policyVersion < 1 || integrationPolicyVersion < 1 {
		return errors.New("replica policy state is incomplete")
	}
	result, err := s.db.Exec(`UPDATE replicas SET policy_version = ?, integration_policy_version = ?, updated_at = ? WHERE space_id = ?`, policyVersion, integrationPolicyVersion, time.Now().UTC().Format(time.RFC3339Nano), spaceID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("replica not found")
	}
	return nil
}

func (s *StateStore) SetReplicaCandidate(spaceID, snapshotID, treeHash string, generation int64, manifest []byte, baseSnapshotID, source string) error {
	if spaceID == "" || snapshotID == "" || treeHash == "" || generation <= 0 || len(manifest) == 0 {
		return errors.New("replica candidate state is incomplete")
	}
	if source != "watcher" && source != "initial_merge" && source != "initial_use_local" {
		return errors.New("replica candidate source is unsupported")
	}
	// A candidate is durable evidence of a local tree that has already been
	// handed to the server. Replacing it before the server resolves it would
	// make the original upload unrecoverable after a crash.
	var existingID, existingTree, existingBase, existingSource string
	var existingGeneration int64
	err := s.db.QueryRow(`SELECT COALESCE(candidate_snapshot_id, ''), COALESCE(candidate_tree_hash, ''), COALESCE(candidate_generation, 0), COALESCE(candidate_base_snapshot_id, ''), COALESCE(candidate_source, '') FROM replicas WHERE space_id = ?`, spaceID).Scan(&existingID, &existingTree, &existingGeneration, &existingBase, &existingSource)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("replica not found")
	}
	if err != nil {
		return err
	}
	if existingID != "" && (existingID != snapshotID || existingTree != treeHash || existingGeneration != generation || existingBase != baseSnapshotID || existingSource != source) {
		return errors.New("a different workspace candidate is still pending")
	}
	_, err = s.db.Exec(`UPDATE replicas SET candidate_snapshot_id = ?, candidate_tree_hash = ?, candidate_generation = ?, candidate_manifest = ?, candidate_base_snapshot_id = ?, candidate_source = ?, status = 'syncing', updated_at = ? WHERE space_id = ?`, snapshotID, treeHash, generation, manifest, nullString(baseSnapshotID), source, time.Now().UTC().Format(time.RFC3339Nano), spaceID)
	return err
}

func (s *StateStore) SetReplicaApplied(spaceID, snapshotID string, generation int64, status string, manifest []byte) error {
	if spaceID == "" || snapshotID == "" || generation < 0 || status == "" || len(manifest) == 0 {
		return errors.New("replica applied state is incomplete")
	}
	result, err := s.db.Exec(`UPDATE replicas SET canonical_snapshot_id = ?, applied_snapshot_id = ?, generation = ?, status = ?, manifest = ?, candidate_snapshot_id = NULL, candidate_tree_hash = NULL, candidate_generation = NULL, candidate_manifest = NULL, candidate_base_snapshot_id = NULL, candidate_source = NULL, updated_at = ? WHERE space_id = ? AND generation <= ?`, snapshotID, snapshotID, generation, status, manifest, time.Now().UTC().Format(time.RFC3339Nano), spaceID, generation)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("workspace apply acknowledgement is stale or replica is missing")
	}
	return nil
}

type ApplyJournalState struct {
	CycleID     string
	Root        string
	JournalPath string
	Status      string
}

func (s *StateStore) RecordApplyJournal(cycleID, root, journalPath string) error {
	if cycleID == "" || root == "" || journalPath == "" {
		return errors.New("apply journal identity is incomplete")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`INSERT INTO applied_journal(cycle_id, root, journal_path, status, created_at, updated_at) VALUES(?, ?, ?, 'applying', ?, ?) ON CONFLICT(cycle_id) DO UPDATE SET root=excluded.root, journal_path=excluded.journal_path, status='applying', updated_at=excluded.updated_at`, cycleID, root, journalPath, now, now)
	return err
}

func (s *StateStore) PendingApplyJournals() ([]ApplyJournalState, error) {
	rows, err := s.db.Query(`SELECT cycle_id, root, journal_path, status FROM applied_journal WHERE status = 'applying' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []ApplyJournalState
	for rows.Next() {
		var item ApplyJournalState
		if err := rows.Scan(&item.CycleID, &item.Root, &item.JournalPath, &item.Status); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *StateStore) DeleteApplyJournal(cycleID string) error {
	_, err := s.db.Exec(`DELETE FROM applied_journal WHERE cycle_id = ?`, cycleID)
	return err
}

func (s *StateStore) SetReplicaAppliedWithJournal(spaceID, snapshotID string, generation int64, status string, manifest []byte, cycleID string) error {
	if spaceID == "" || snapshotID == "" || generation < 0 || status == "" || len(manifest) == 0 || cycleID == "" {
		return errors.New("replica applied journal state is incomplete")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE replicas SET canonical_snapshot_id = ?, applied_snapshot_id = ?, generation = ?, status = ?, manifest = ?, candidate_snapshot_id = NULL, candidate_tree_hash = NULL, candidate_generation = NULL, candidate_manifest = NULL, candidate_base_snapshot_id = NULL, candidate_source = NULL, updated_at = ? WHERE space_id = ? AND generation <= ?`, snapshotID, snapshotID, generation, status, manifest, time.Now().UTC().Format(time.RFC3339Nano), spaceID, generation)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("workspace apply acknowledgement is stale or replica is missing")
	}
	journalResult, err := tx.Exec(`UPDATE applied_journal SET status='committed', updated_at=? WHERE cycle_id=? AND status='applying'`, time.Now().UTC().Format(time.RFC3339Nano), cycleID)
	if err != nil {
		return err
	}
	journalAffected, err := journalResult.RowsAffected()
	if err != nil {
		return err
	}
	if journalAffected != 1 {
		return errors.New("workspace apply journal is unavailable")
	}
	return tx.Commit()
}

func (s *StateStore) ReplicaForSpace(spaceID string) (*ReplicaState, error) {
	var item ReplicaState
	err := s.db.QueryRow(`SELECT space_id, replica_id, root, root_fingerprint, device_id, policy_version, integration_policy_version, COALESCE(canonical_snapshot_id, ''), COALESCE(applied_snapshot_id, ''), generation, status, COALESCE(manifest, X''), COALESCE(candidate_snapshot_id, ''), COALESCE(candidate_tree_hash, ''), COALESCE(candidate_generation, 0), COALESCE(candidate_manifest, X''), COALESCE(candidate_base_snapshot_id, ''), COALESCE(candidate_source, ''), COALESCE(initial_choice, ''), updated_at FROM replicas WHERE space_id = ?`, spaceID).Scan(&item.SpaceID, &item.ReplicaID, &item.Root, &item.RootFingerprint, &item.DeviceID, &item.PolicyVersion, &item.IntegrationPolicyVersion, &item.CanonicalSnapshotID, &item.AppliedSnapshotID, &item.Generation, &item.Status, &item.Manifest, &item.CandidateSnapshotID, &item.CandidateTreeHash, &item.CandidateGeneration, &item.CandidateManifest, &item.CandidateBaseSnapshotID, &item.CandidateSource, &item.InitialChoice, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *StateStore) AppendSpool(eventID string, payload []byte) (int64, error) {
	if eventID == "" || len(payload) == 0 {
		return 0, errors.New("spool event identity and payload are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.Exec(`INSERT INTO spool(event_id, payload, status, created_at) VALUES(?, ?, 'pending', ?) ON CONFLICT(event_id) DO NOTHING`, eventID, payload, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		var sequence int64
		err := s.db.QueryRow(`SELECT sequence FROM spool WHERE event_id = ?`, eventID).Scan(&sequence)
		return sequence, err
	}
	var sequence int64
	if err := s.db.QueryRow(`SELECT sequence FROM spool WHERE event_id = ?`, eventID).Scan(&sequence); err != nil {
		return 0, err
	}
	return sequence, nil
}

type SpoolItem struct {
	Sequence    int64
	EventID     string
	Payload     []byte
	Attempts    int
	NextAttempt time.Time
}

func (s *StateStore) PendingSpool(ctx context.Context, limit int) ([]SpoolItem, error) {
	if limit < 1 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT sequence, event_id, payload, attempt_count, COALESCE(next_attempt_at, '') FROM spool WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY sequence LIMIT ?`, time.Now().UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]SpoolItem, 0, limit)
	for rows.Next() {
		var item SpoolItem
		var next string
		if err := rows.Scan(&item.Sequence, &item.EventID, &item.Payload, &item.Attempts, &next); err != nil {
			return nil, err
		}
		if next != "" {
			item.NextAttempt, _ = time.Parse(time.RFC3339Nano, next)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *StateStore) ReplaceSpoolPayload(sequence int64, payload []byte) error {
	if len(payload) == 0 {
		return errors.New("spool payload is required")
	}
	_, err := s.db.Exec(`UPDATE spool SET payload = ? WHERE sequence = ? AND status = 'pending'`, payload, sequence)
	return err
}

func (s *StateStore) MarkSpoolResult(sequence int64, success bool, message string) error {
	if success {
		_, err := s.db.Exec(`UPDATE spool SET status = 'applied', last_error = NULL WHERE sequence = ?`, sequence)
		return err
	}
	var attempts int
	if err := s.db.QueryRow(`SELECT attempt_count FROM spool WHERE sequence = ? AND status = 'pending'`, sequence).Scan(&attempts); err != nil {
		return err
	}
	shift := attempts
	if shift > 7 {
		shift = 7
	}
	delay := time.Duration(1<<shift) * 2 * time.Second
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	attemptAt := time.Now().UTC().Add(delay).Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE spool SET attempt_count = attempt_count + 1, next_attempt_at = ?, last_error = ? WHERE sequence = ? AND status = 'pending'`, attemptAt, message, sequence)
	return err
}

func (s *StateStore) PutPermit(executionAttemptID, spaceID, replicaID, baseSnapshotID string, leaseEpoch int64, expiresAt time.Time, holderKind, holderID string) error {
	if holderKind == "" {
		holderKind = "local_agent"
	}
	if holderID == "" {
		holderID = executionAttemptID
	}
	_, err := s.db.Exec(`INSERT INTO permits(execution_attempt_id, space_id, replica_id, base_snapshot_id, lease_epoch, expires_at, holder_kind, holder_id, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?) ON CONFLICT(execution_attempt_id) DO UPDATE SET expires_at=excluded.expires_at, lease_epoch=excluded.lease_epoch, holder_kind=excluded.holder_kind, holder_id=excluded.holder_id, status='prepared'`, executionAttemptID, spaceID, replicaID, nullString(baseSnapshotID), leaseEpoch, expiresAt.UTC().Format(time.RFC3339Nano), holderKind, holderID, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *StateStore) ClaimAcpRuntimePermit(executionAttemptID, spaceID, replicaID, baseSnapshotID string, leaseEpoch int64, expiresAt time.Time) error {
	if executionAttemptID == "" || spaceID == "" || replicaID == "" || leaseEpoch < 1 || !expiresAt.After(time.Now().UTC()) {
		return errors.New("ACP execution permit input is invalid or expired")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	rollback := func(cause error) error {
		_ = tx.Rollback()
		return cause
	}
	result, err := tx.Exec(`INSERT INTO permits(execution_attempt_id, space_id, replica_id, base_snapshot_id, lease_epoch, expires_at, holder_kind, holder_id, status, created_at) VALUES(?, ?, ?, ?, ?, ?, 'local_agent', ?, 'active', ?) ON CONFLICT(execution_attempt_id) DO NOTHING`, executionAttemptID, spaceID, replicaID, nullString(baseSnapshotID), leaseEpoch, expiresAt.UTC().Format(time.RFC3339Nano), acpRuntimePermitHolderID(executionAttemptID), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return rollback(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return rollback(err)
	}
	if affected != 1 {
		return rollback(errors.New("ACP execution permit was already consumed"))
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

func (s *StateStore) LatestPermitForReplica(spaceID, replicaID string) (executionAttemptID string, valid bool, err error) {
	var expires string
	err = s.db.QueryRow(`SELECT execution_attempt_id, expires_at FROM permits WHERE space_id = ? AND replica_id = ? AND status = 'prepared' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`, spaceID, replicaID, time.Now().UTC().Format(time.RFC3339Nano)).Scan(&executionAttemptID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	parsed, parseErr := time.Parse(time.RFC3339Nano, expires)
	return executionAttemptID, parseErr == nil && parsed.After(time.Now().UTC()), parseErr
}

func (s *StateStore) ConsumePermit(executionAttemptID string) error {
	result, err := s.db.Exec(`UPDATE permits SET status = 'active' WHERE execution_attempt_id = ? AND status = 'prepared' AND expires_at > ?`, executionAttemptID, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errors.New("execution permit is no longer available")
	}
	return nil
}

type PermitContext struct {
	ExecutionAttemptID string
	SpaceID            string
	ReplicaID          string
	BaseSnapshotID     string
	LeaseEpoch         int64
	ExpiresAt          time.Time
	Status             string
	HolderKind         string
	HolderID           string
}

func (s *StateStore) PermitContext(executionAttemptID string) (*PermitContext, error) {
	var item PermitContext
	var expires string
	err := s.db.QueryRow(`SELECT execution_attempt_id, space_id, replica_id, COALESCE(base_snapshot_id, ''), COALESCE(lease_epoch, 0), expires_at, status, holder_kind, holder_id FROM permits WHERE execution_attempt_id = ?`, executionAttemptID).Scan(&item.ExecutionAttemptID, &item.SpaceID, &item.ReplicaID, &item.BaseSnapshotID, &item.LeaseEpoch, &expires, &item.Status, &item.HolderKind, &item.HolderID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
	return &item, nil
}

type ActivePermit struct {
	ExecutionAttemptID string
	SpaceID            string
	ReplicaID          string
	LeaseEpoch         int64
	ExpiresAt          time.Time
	HolderKind         string
	HolderID           string
}

func (s *StateStore) ActivePermits(ctx context.Context) ([]ActivePermit, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT execution_attempt_id, space_id, replica_id, COALESCE(lease_epoch, 0), expires_at, holder_kind, holder_id FROM permits WHERE status = 'active'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []ActivePermit
	for rows.Next() {
		var item ActivePermit
		var expires string
		if err := rows.Scan(&item.ExecutionAttemptID, &item.SpaceID, &item.ReplicaID, &item.LeaseEpoch, &expires, &item.HolderKind, &item.HolderID); err != nil {
			return nil, err
		}
		item.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expires)
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *StateStore) UpdatePermitExpiry(executionAttemptID string, expiresAt time.Time) error {
	_, err := s.db.Exec(`UPDATE permits SET expires_at = ? WHERE execution_attempt_id = ? AND status = 'active'`, expiresAt.UTC().Format(time.RFC3339Nano), executionAttemptID)
	return err
}

func (s *StateStore) CompletePermit(executionAttemptID string) error {
	_, err := s.db.Exec(`UPDATE permits SET status = 'completed' WHERE execution_attempt_id = ? AND status IN ('prepared', 'active', 'expired')`, executionAttemptID)
	return err
}

func (s *StateStore) Permit(executionAttemptID string) (spaceID, replicaID string, valid bool, err error) {
	var expires string
	err = s.db.QueryRow(`SELECT space_id, replica_id, expires_at FROM permits WHERE execution_attempt_id = ? AND status IN ('prepared', 'active')`, executionAttemptID).Scan(&spaceID, &replicaID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	parsed, parseErr := time.Parse(time.RFC3339Nano, expires)
	return spaceID, replicaID, parseErr == nil && parsed.After(time.Now().UTC()), parseErr
}

func nullInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func EncodeJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}
