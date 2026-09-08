package locald

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	protocolVersion        = 1
	credentialAccessToken  = "access-token"
	credentialRefreshToken = "refresh-token"
	credentialDeviceID     = "device-id"
)

type Daemon struct {
	cfg        Config
	state      *StateStore
	identity   []byte
	client     *http.Client
	mu         sync.Mutex
	identityMu sync.RWMutex
	tokenMu    sync.RWMutex
}

type IPCRequest struct {
	Version            int    `json:"version"`
	Type               string `json:"type"`
	CWD                string `json:"cwd,omitempty"`
	SpaceID            string `json:"spaceId,omitempty"`
	ReplicaID          string `json:"replicaId,omitempty"`
	Root               string `json:"root,omitempty"`
	RootFingerprint    string `json:"rootFingerprint,omitempty"`
	Device             string `json:"deviceId,omitempty"`
	PolicyVersion      int64  `json:"policyVersion,omitempty"`
	IntegrationVersion int64  `json:"integrationPolicyVersion,omitempty"`
	InitialChoice      string `json:"initialChoice,omitempty"`
}

type IPCResponse struct {
	Version         int    `json:"version"`
	OK              bool   `json:"ok"`
	Code            string `json:"code,omitempty"`
	Message         string `json:"message,omitempty"`
	EventID         string `json:"eventId,omitempty"`
	LocalReceiptSeq int64  `json:"localReceiptSequence,omitempty"`
	SpaceID         string `json:"spaceId,omitempty"`
	ReplicaID       string `json:"replicaId,omitempty"`
	RelativeCWD     string `json:"relativeCwd,omitempty"`
	Data            any    `json:"data,omitempty"`
}

type spoolEnvelope struct {
	Kind               string `json:"kind"`
	Version            int    `json:"version"`
	EventID            string `json:"eventId"`
	SpaceID            string `json:"spaceId"`
	ReplicaID          string `json:"replicaId"`
	ExecutionAttemptID string `json:"executionAttemptId,omitempty"`
	RuntimeID          string `json:"runtimeId,omitempty"`
	LeaseEpoch         int64  `json:"leaseEpoch,omitempty"`
	ErrorMessage       string `json:"errorMessage,omitempty"`
}

func NewDaemon(cfg Config) (*Daemon, error) {
	cfg = cfg.normalize()
	state, err := OpenState(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	identity, err := LoadOrCreateIdentity()
	if err != nil {
		_ = state.Close()
		return nil, err
	}
	if cfg.DaemonVersion == "" {
		cfg.DaemonVersion = "dev"
	}
	daemon := &Daemon{
		cfg:      cfg,
		state:    state,
		identity: identity,
		client:   &http.Client{Timeout: cfg.HTTPTimeout},
	}
	if err := recoverLocalApplyJournals(state, cfg.DataDir); err != nil {
		_ = state.Close()
		return nil, err
	}
	return daemon, nil
}

func (d *Daemon) Close() error {
	return d.state.Close()
}

func (d *Daemon) apiBaseURL() string {
	if value, err := d.state.GetMeta("api_base_url"); err == nil && strings.TrimSpace(value) != "" {
		return strings.TrimRight(strings.TrimSpace(value), "/")
	}
	return strings.TrimRight(strings.TrimSpace(d.cfg.APIBaseURL), "/")
}

func (d *Daemon) identityKey() []byte {
	d.identityMu.RLock()
	defer d.identityMu.RUnlock()
	return append([]byte(nil), d.identity...)
}

func (d *Daemon) setIdentity(identity []byte) {
	d.identityMu.Lock()
	defer d.identityMu.Unlock()
	d.identity = append([]byte(nil), identity...)
}

func (d *Daemon) Run(ctx context.Context) error {
	listener, err := listenEndpoint(d.cfg.SocketPath)
	if err != nil {
		return fmt.Errorf("listen locald IPC: %w", err)
	}
	defer func() {
		_ = listener.Close()
		closeEndpoint(d.cfg.SocketPath)
	}()

	go d.replayLoop(ctx)
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(acceptErr, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept locald IPC: %w", acceptErr)
		}
		go d.handleConnection(ctx, conn)
	}
}

func (d *Daemon) handleConnection(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(bufio.NewReader(io.LimitReader(conn, 4*1024*1024)))
	encoder := json.NewEncoder(conn)
	var request IPCRequest
	if err := decoder.Decode(&request); err != nil {
		_ = encoder.Encode(IPCResponse{Version: protocolVersion, Code: "invalid_request", Message: "invalid locald IPC request"})
		return
	}
	response := d.handleRequest(ctx, request)
	_ = encoder.Encode(response)
}

func (d *Daemon) handleRequest(ctx context.Context, request IPCRequest) IPCResponse {
	if request.Version != protocolVersion {
		return IPCResponse{Version: protocolVersion, Code: "protocol_version_unsupported", Message: "locald protocol version is unsupported"}
	}
	switch request.Type {
	case "ping":
		return IPCResponse{Version: protocolVersion, OK: true, Data: map[string]any{"daemonVersion": d.cfg.DaemonVersion}}
	case "configure_replica":
		return d.configureReplica(request)
	case "status":
		return d.status(request)
	case "flush":
		go d.replayOnce(ctx)
		return IPCResponse{Version: protocolVersion, OK: true}
	case "refresh":
		d.syncReplicas(ctx)
		return IPCResponse{Version: protocolVersion, OK: true}
	default:
		return IPCResponse{Version: protocolVersion, Code: "unknown_request", Message: "unknown locald IPC request"}
	}
}

func (d *Daemon) configureReplica(request IPCRequest) IPCResponse {
	if request.SpaceID == "" || request.ReplicaID == "" || request.Root == "" || request.RootFingerprint == "" || request.DeviceID() == "" {
		return IPCResponse{Version: protocolVersion, Code: "replica_identity_incomplete", Message: "spaceId, replicaId, root, rootFingerprint, and deviceId are required"}
	}
	if request.InitialChoice != "use-cloud" && request.InitialChoice != "use-local" && request.InitialChoice != "merge" {
		return IPCResponse{Version: protocolVersion, Code: "initial_choice_required", Message: "initialChoice must be use-cloud, use-local, or merge"}
	}
	root, err := CanonicalWorkspaceRoot(request.Root)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "invalid_root", Message: err.Error()}
	}
	if info, statErr := os.Stat(root); statErr != nil || !info.IsDir() {
		message := "workspace root must be an existing directory"
		if statErr != nil {
			message = statErr.Error()
		}
		return IPCResponse{Version: protocolVersion, Code: "invalid_root", Message: message}
	}
	identity, err := LoadOrCreateIdentity()
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "identity_reload_failed", Message: err.Error()}
	}
	d.setIdentity(identity)
	if RootFingerprint(identity, request.SpaceID, root) != request.RootFingerprint {
		return IPCResponse{Version: protocolVersion, Code: "root_fingerprint_mismatch", Message: "root fingerprint does not match the canonical workspace path"}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.state.AssertReplicaRootAvailable(request.SpaceID, request.ReplicaID, root); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "replica_root_overlap", Message: err.Error()}
	}
	if err := d.state.UpsertReplica(ReplicaState{
		SpaceID:                  request.SpaceID,
		ReplicaID:                request.ReplicaID,
		Root:                     root,
		RootFingerprint:          request.RootFingerprint,
		DeviceID:                 request.DeviceID(),
		PolicyVersion:            request.PolicyVersion,
		IntegrationPolicyVersion: request.IntegrationVersion,
		InitialChoice:            request.InitialChoice,
		Status:                   "attaching",
		UpdatedAt:                time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "replica_state_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, SpaceID: request.SpaceID, ReplicaID: request.ReplicaID}
}

func (d *Daemon) status(request IPCRequest) IPCResponse {
	if request.CWD != "" {
		replica, err := d.state.ReplicaForPath(request.CWD)
		if err != nil {
			return IPCResponse{Version: protocolVersion, Code: "state_failed", Message: err.Error()}
		}
		if replica == nil {
			return IPCResponse{Version: protocolVersion, OK: true, Data: nil}
		}
		return IPCResponse{Version: protocolVersion, OK: true, SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID, RelativeCWD: relativeCWD(replica.Root, request.CWD), Data: replica}
	}
	deviceID := strings.TrimSpace(d.cfg.DeviceID)
	if deviceID == "" {
		if credential, credentialErr := LoadCredential(credentialDeviceID); credentialErr == nil {
			deviceID = strings.TrimSpace(credential)
		}
	}
	replicaRoots, err := d.state.ReplicaRoots()
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "state_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, Data: map[string]any{
		"dataDir":    d.cfg.DataDir,
		"socketPath": d.cfg.SocketPath,
		"deviceId":   nullableString(deviceID),
		"replicas":   replicaRoots,
	}}
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
func (d *Daemon) replayLoop(ctx context.Context) {
	ticker := time.NewTicker(d.cfg.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.syncReplicas(ctx)
			d.replayOnce(ctx)
		}
	}
}
func (d *Daemon) replayOnce(ctx context.Context) {
	items, err := d.state.PendingSpool(ctx, 50)
	if err != nil {
		return
	}
	for _, item := range items {
		var envelope spoolEnvelope
		if err := json.Unmarshal(item.Payload, &envelope); err != nil {
			_ = d.state.MarkSpoolResult(item.Sequence, false, "invalid local spool payload")
			continue
		}
		var uploadErr error
		switch envelope.Kind {
		case "workspace_terminal":
			uploadErr = d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID)
		case "runtime_start_failed":
			uploadErr = d.failLocalRuntimeAttemptBeforeStart(ctx, envelope)
		default:
			// Unknown spool kinds are retired rather than retried forever. The
			// local runtime is the only spool producer.
			_ = d.state.MarkSpoolResult(item.Sequence, true, "")
			continue
		}
		if uploadErr != nil {
			_ = d.state.MarkSpoolResult(item.Sequence, false, uploadErr.Error())
			continue
		}
		_ = d.state.MarkSpoolResult(item.Sequence, true, "")
	}
}

// failLocalRuntimeAttemptBeforeStart applies the durable cleanup record made
// when locald claimed a permit but could not spawn the native provider. The
// server mutation is idempotent; only after it confirms a terminal attempt do
// we retire the local permit.
func (d *Daemon) failLocalRuntimeAttemptBeforeStart(ctx context.Context, envelope spoolEnvelope) error {
	if strings.TrimSpace(envelope.SpaceID) == "" || strings.TrimSpace(envelope.ReplicaID) == "" || strings.TrimSpace(envelope.ExecutionAttemptID) == "" || strings.TrimSpace(envelope.RuntimeID) == "" || envelope.LeaseEpoch < 1 {
		return errors.New("local runtime start failure spool provenance is incomplete")
	}
	payload := mustJSON(map[string]any{
		"runtimeId":    envelope.RuntimeID,
		"leaseEpoch":   envelope.LeaseEpoch,
		"errorMessage": strings.TrimSpace(envelope.ErrorMessage),
	})
	body, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/attempts/%s/fail-before-start", d.apiBaseURL(), envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID), payload, 2*1024*1024)
	if err != nil {
		return err
	}
	var response struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &response); err != nil || !isTerminalAttemptStatus(response.Status) {
		return errors.New("local runtime start failure response is invalid")
	}
	if err := d.state.CompletePermit(envelope.ExecutionAttemptID); err != nil {
		return fmt.Errorf("complete local runtime permit after start failure: %w", err)
	}
	return nil
}

func isTerminalAttemptStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "failed", "aborted", "completed":
		return true
	default:
		return false
	}
}

func (d *Daemon) accessToken() (string, error) {
	d.tokenMu.RLock()
	token := strings.TrimSpace(d.cfg.AccessToken)
	d.tokenMu.RUnlock()
	if token != "" {
		return token, nil
	}
	value, err := keyring.Get(keyringService, credentialAccessToken)
	if err == nil && strings.TrimSpace(value) != "" {
		return value, nil
	}
	return "", errors.New("local agent access token is unavailable")
}

func (d *Daemon) setAccessToken(token string) {
	d.tokenMu.Lock()
	d.cfg.AccessToken = strings.TrimSpace(token)
	d.tokenMu.Unlock()
}

func (d *Daemon) releaseExecutionPermit(ctx context.Context, spaceID, executionAttemptID string) error {
	permit, err := d.state.PermitContext(executionAttemptID)
	if err != nil {
		return err
	}
	if permit == nil || permit.SpaceID != spaceID || permit.Status == "completed" || (permit.Status == "expired" && !isLocalRuntimePermit(permit.HolderID)) || (permit.Status != "prepared" && permit.Status != "active" && permit.Status != "expired") {
		return nil
	}
	runtimeID, err := runtimeIDForPermit(permit)
	if err != nil {
		return err
	}
	payload := mustJSON(map[string]any{
		"holderKind": permit.HolderKind,
		"holderId":   serverPermitHolderID(permit.HolderID),
		"runtimeId":  runtimeID,
		"epoch":      permit.LeaseEpoch,
	})
	if _, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/leases/release", d.apiBaseURL(), spaceID), payload, 2*1024*1024); err != nil {
		return err
	}
	return d.state.CompletePermit(executionAttemptID)
}
func relativeCWD(root, cwd string) string {
	root, _ = filepath.Abs(root)
	cwd, _ = filepath.Abs(cwd)
	rel, err := filepath.Rel(root, cwd)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "."
	}
	if rel == "." {
		return "."
	}
	return filepath.ToSlash(rel)
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"error":"serialization_failed"}`)
	}
	return encoded
}

func (request IPCRequest) DeviceID() string {
	return strings.TrimSpace(request.Device)
}
