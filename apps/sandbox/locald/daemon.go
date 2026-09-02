package locald

import (
	"bufio"
	"bytes"
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

	"github.com/google/uuid"
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
}

type IPCRequest struct {
	Version            int             `json:"version"`
	Type               string          `json:"type"`
	Provider           string          `json:"provider,omitempty"`
	ProviderVersion    string          `json:"providerVersion,omitempty"`
	Event              string          `json:"event,omitempty"`
	CWD                string          `json:"cwd,omitempty"`
	SpaceID            string          `json:"spaceId,omitempty"`
	ReplicaID          string          `json:"replicaId,omitempty"`
	Root               string          `json:"root,omitempty"`
	RootFingerprint    string          `json:"rootFingerprint,omitempty"`
	Device             string          `json:"deviceId,omitempty"`
	PolicyVersion      int64           `json:"policyVersion,omitempty"`
	IntegrationVersion int64           `json:"integrationPolicyVersion,omitempty"`
	MirrorMode         string          `json:"sessionMirrorMode,omitempty"`
	InitialChoice      string          `json:"initialChoice,omitempty"`
	ExecutionAttemptID string          `json:"executionAttemptId,omitempty"`
	BaseSnapshotID     string          `json:"baseSnapshotId,omitempty"`
	LeaseEpoch         int64           `json:"leaseEpoch,omitempty"`
	LeaseHolderKind    string          `json:"leaseHolderKind,omitempty"`
	LeaseHolderID      string          `json:"leaseHolderId,omitempty"`
	ExpiresAt          string          `json:"expiresAt,omitempty"`
	Payload            json.RawMessage `json:"payload,omitempty"`
	Bundle             json.RawMessage `json:"bundle,omitempty"`
}

type IPCResponse struct {
	Version            int    `json:"version"`
	OK                 bool   `json:"ok"`
	Code               string `json:"code,omitempty"`
	Message            string `json:"message,omitempty"`
	EventID            string `json:"eventId,omitempty"`
	LocalReceiptSeq    int64  `json:"localReceiptSequence,omitempty"`
	ExecutionAttemptID string `json:"executionAttemptId,omitempty"`
	SpaceID            string `json:"spaceId,omitempty"`
	ReplicaID          string `json:"replicaId,omitempty"`
	RelativeCWD        string `json:"relativeCwd,omitempty"`
	Data               any    `json:"data,omitempty"`
}

type sanitizedHookEnvelope struct {
	Version                  int            `json:"version"`
	ExecutionAttemptID       *string        `json:"executionAttemptId"`
	EventID                  string         `json:"eventId"`
	ObservedAt               string         `json:"observedAt"`
	DeviceID                 string         `json:"deviceId"`
	ReplicaID                string         `json:"replicaId"`
	Provider                 string         `json:"provider"`
	ProviderVersion          string         `json:"providerVersion"`
	AdapterVersion           string         `json:"adapterVersion"`
	IdentityKeyVersion       int            `json:"identityKeyVersion"`
	WorkspacePolicyVersion   int64          `json:"workspacePolicyVersion"`
	IntegrationPolicyVersion int64          `json:"integrationPolicyVersion"`
	SessionMirrorMode        string         `json:"sessionMirrorMode"`
	NativeSessionKey         string         `json:"nativeSessionKey"`
	NativeTurnKey            *string        `json:"nativeTurnKey"`
	NativeEventSequence      *int64         `json:"nativeEventSequence"`
	LocalReceiptSequence     int64          `json:"localReceiptSequence"`
	Type                     string         `json:"type"`
	Workspace                map[string]any `json:"workspace"`
	Payload                  map[string]any `json:"payload"`
}

type spoolEnvelope struct {
	Kind               string          `json:"kind"`
	Version            int             `json:"version"`
	EventID            string          `json:"eventId"`
	SpaceID            string          `json:"spaceId"`
	ReplicaID          string          `json:"replicaId"`
	ExecutionAttemptID string          `json:"executionAttemptId,omitempty"`
	Bundle             json.RawMessage `json:"bundle,omitempty"`
	Hook               json.RawMessage `json:"hook,omitempty"`
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
	case "permit":
		return d.preparePermit(request)
	case "preflight":
		return d.preflight(request)
	case "hook":
		return d.acceptHook(request)
	case "bundle":
		return d.acceptBundle(request)
	case "collect_pi":
		return d.collectPI(request)
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
		MirrorMode:               request.MirrorMode,
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
	return IPCResponse{Version: protocolVersion, OK: true, Data: map[string]any{"dataDir": d.cfg.DataDir, "socketPath": d.cfg.SocketPath}}
}

func (d *Daemon) preparePermit(request IPCRequest) IPCResponse {
	if request.ExecutionAttemptID == "" || request.SpaceID == "" || request.ReplicaID == "" {
		return IPCResponse{Version: protocolVersion, Code: "permit_identity_incomplete", Message: "executionAttemptId, spaceId, and replicaId are required"}
	}
	expiresAt := time.Now().UTC().Add(30 * time.Second)
	if request.ExpiresAt != "" {
		parsed, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
		if err != nil || !parsed.After(time.Now().UTC()) {
			return IPCResponse{Version: protocolVersion, Code: "permit_expired", Message: "permit expiry is invalid"}
		}
		expiresAt = parsed
	}
	holderKind := strings.TrimSpace(request.LeaseHolderKind)
	if holderKind == "" {
		holderKind = "local_agent"
	}
	if holderKind != "local_agent" && holderKind != "local_offline_reservation" {
		return IPCResponse{Version: protocolVersion, Code: "permit_holder_invalid", Message: "lease holder kind is unsupported"}
	}
	holderID := strings.TrimSpace(request.LeaseHolderID)
	if holderID == "" {
		holderID = request.ExecutionAttemptID
	}
	if err := d.state.PutPermit(request.ExecutionAttemptID, request.SpaceID, request.ReplicaID, request.BaseSnapshotID, request.LeaseEpoch, expiresAt, holderKind, holderID); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "permit_persist_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, ExecutionAttemptID: request.ExecutionAttemptID, SpaceID: request.SpaceID, ReplicaID: request.ReplicaID}
}

func (d *Daemon) preflight(request IPCRequest) IPCResponse {
	if request.CWD == "" {
		return IPCResponse{Version: protocolVersion, Code: "cwd_required", Message: "cwd is required"}
	}
	replica, err := d.state.ReplicaForPath(request.CWD)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "state_failed", Message: err.Error()}
	}
	if replica == nil {
		return IPCResponse{Version: protocolVersion, Code: "workspace_unattached", Message: "Workspace is not attached to CoHub."}
	}
	attemptID := request.ExecutionAttemptID
	if attemptID == "" {
		var valid bool
		attemptID, valid, err = d.state.LatestPermitForReplica(replica.SpaceID, replica.ReplicaID)
		if err != nil {
			return IPCResponse{Version: protocolVersion, Code: "permit_read_failed", Message: err.Error()}
		}
		if !valid {
			return IPCResponse{Version: protocolVersion, Code: "workspace_not_ready", Message: "Workspace handoff is not ready. Wait for CoHub sync, then submit again."}
		}
	}
	spaceID, replicaID, valid, err := d.state.Permit(attemptID)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "permit_read_failed", Message: err.Error()}
	}
	if !valid || spaceID != replica.SpaceID || replicaID != replica.ReplicaID {
		return IPCResponse{Version: protocolVersion, Code: "workspace_not_ready", Message: "Workspace handoff is not ready. Wait for CoHub sync, then submit again."}
	}
	if err := d.state.ConsumePermit(attemptID); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "workspace_not_ready", Message: "Workspace handoff permit was already consumed."}
	}
	return IPCResponse{Version: protocolVersion, OK: true, ExecutionAttemptID: attemptID, SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID, RelativeCWD: relativeCWD(replica.Root, request.CWD)}
}

func (d *Daemon) buildHookEnvelope(request IPCRequest, replica *ReplicaState) (sanitizedHookEnvelope, error) {
	var raw map[string]any
	if err := json.Unmarshal(request.Payload, &raw); err != nil {
		return sanitizedHookEnvelope{}, err
	}
	clean, err := sanitizeValue(raw, 0)
	if err != nil {
		return sanitizedHookEnvelope{}, err
	}
	payload, ok := clean.(map[string]any)
	if !ok {
		return sanitizedHookEnvelope{}, errors.New("hook payload must be a JSON object")
	}
	if len(mustJSON(payload)) > 64*1024 {
		return sanitizedHookEnvelope{}, errors.New("hook payload exceeds 64 KiB after redaction")
	}
	deviceID := strings.TrimSpace(replica.DeviceID)
	if deviceID == "" {
		return sanitizedHookEnvelope{}, errors.New("local agent device id is unavailable")
	}
	identity := d.identityKey()
	payload = sanitizeProviderPayloadIdentifiers(payload, identity, replica.SpaceID, replica.ReplicaID, request.Provider).(map[string]any)
	if replica.MirrorMode == "metadata_only" {
		payload = metadataOnlyHookPayload(payload)
	}
	rawSession := firstPayloadString(raw, "sessionId", "session_id", "conversationId", "conversation_id", "threadId", "thread_id")
	if rawSession == "" {
		rawSession = "cwd:" + replica.Root
	}
	homeNamespace := firstPayloadString(raw, "homeNamespace", "providerHomeNamespace", "providerHomeFingerprint")
	if homeNamespace == "" {
		if request.Provider == "pi" {
			homeNamespace = "pi-agent"
		} else {
			homeNamespace = "provider-home"
		}
	}
	hookType, err := normalizeHookType(request.Event)
	if err != nil {
		return sanitizedHookEnvelope{}, err
	}
	rawTurn := firstPayloadString(raw, "turnId", "turn_id", "promptId", "prompt_id", "turnID")
	executionAttemptID := strings.TrimSpace(request.ExecutionAttemptID)
	if executionAttemptID == "" && rawTurn != "" {
		executionAttemptID, err = d.state.ResolveProviderAttempt(request.Provider, rawSession, rawTurn)
		if err != nil {
			return sanitizedHookEnvelope{}, err
		}
	}
	if executionAttemptID == "" && hookType != "session_started" {
		executionAttemptID, err = d.state.ResolveLatestProviderAttempt(request.Provider, rawSession)
		if err != nil {
			return sanitizedHookEnvelope{}, err
		}
	}
	if rawTurn == "" && executionAttemptID != "" {
		rawTurn = "attempt:" + executionAttemptID
	}
	if executionAttemptID != "" && rawTurn != "" {
		if err := d.state.MapProviderAttempt(request.Provider, rawSession, rawTurn, executionAttemptID); err != nil {
			return sanitizedHookEnvelope{}, err
		}
	}
	leaseEpoch := request.LeaseEpoch
	if executionAttemptID != "" && leaseEpoch <= 0 {
		permit, permitErr := d.state.PermitContext(executionAttemptID)
		if permitErr != nil {
			return sanitizedHookEnvelope{}, permitErr
		}
		if permit != nil && permit.SpaceID == replica.SpaceID && permit.ReplicaID == replica.ReplicaID && permit.ExpiresAt.After(time.Now().UTC()) && (permit.Status == "prepared" || permit.Status == "active") {
			leaseEpoch = permit.LeaseEpoch
		}
	}
	var nativeTurnKey *string
	if rawTurn != "" {
		value := NativeTurnKey(identity, replica.SpaceID, replica.ReplicaID, request.Provider, rawTurn)
		nativeTurnKey = &value
	}
	var nativeEventSequence *int64
	if sequence, ok := firstPayloadInt(raw, "sequence", "eventSequence", "event_sequence"); ok {
		nativeEventSequence = &sequence
	}
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	return sanitizedHookEnvelope{
		Version:                  protocolVersion,
		ExecutionAttemptID:       optionalString(executionAttemptID),
		EventID:                  uuid.NewString(),
		ObservedAt:               observedAt,
		DeviceID:                 deviceID,
		ReplicaID:                replica.ReplicaID,
		Provider:                 request.Provider,
		ProviderVersion:          firstNonEmpty(request.ProviderVersion, "unknown"),
		AdapterVersion:           "locald-hook-v1",
		IdentityKeyVersion:       1,
		WorkspacePolicyVersion:   replica.PolicyVersion,
		IntegrationPolicyVersion: replica.IntegrationPolicyVersion,
		SessionMirrorMode:        firstNonEmpty(replica.MirrorMode, "disabled"),
		NativeSessionKey:         NativeSessionKey(identity, replica.SpaceID, replica.ReplicaID, request.Provider, homeNamespace, rawSession),
		NativeTurnKey:            nativeTurnKey,
		NativeEventSequence:      nativeEventSequence,
		Type:                     hookType,
		Workspace: map[string]any{
			"relativeCwd":             relativeCWD(replica.Root, request.CWD),
			"baseCanonicalSnapshotId": nullableString(replica.CanonicalSnapshotID),
			"localSnapshotId":         nullableString(replica.AppliedSnapshotID),
			"leaseEpoch":              nullableInt(leaseEpoch),
		},
		Payload: payload,
	}, nil
}

func normalizeHookType(event string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(event))
	switch {
	case strings.Contains(value, "session_start") || strings.Contains(value, "session-start") || strings.Contains(value, "sessionstart"):
		return "session_started", nil
	case strings.Contains(value, "prompt") || strings.Contains(value, "user_prompt"):
		return "prompt_submitted", nil
	case strings.Contains(value, "turn_start") || strings.Contains(value, "turn-start") || strings.Contains(value, "turnstart"):
		return "turn_started", nil
	case strings.Contains(value, "tool_start") || strings.Contains(value, "pre_tool") || strings.Contains(value, "pretool"):
		return "tool_started", nil
	case strings.Contains(value, "tool_end") || strings.Contains(value, "post_tool") || strings.Contains(value, "tool_finish") || strings.Contains(value, "posttool"):
		return "tool_finished", nil
	case strings.Contains(value, "message") && (strings.Contains(value, "finish") || strings.Contains(value, "complete")):
		return "message_finished", nil
	case strings.Contains(value, "error") || strings.Contains(value, "fail"):
		return "turn_failed", nil
	case strings.Contains(value, "turn_end") || strings.Contains(value, "turn-stop") || strings.Contains(value, "turnend") || strings.Contains(value, "stop"):
		return "turn_stopped", nil
	case strings.Contains(value, "compact"):
		return "session_compacted", nil
	case strings.Contains(value, "session_end") || strings.Contains(value, "session-end") || strings.Contains(value, "sessionend"):
		return "session_ended", nil
	case strings.Contains(value, "exit"):
		return "provider_exited", nil
	default:
		return "", fmt.Errorf("unsupported provider hook event %q", event)
	}
}

func firstPayloadString(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstPayloadInt(payload map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		switch value := payload[key].(type) {
		case float64:
			if value >= 0 && value == float64(int64(value)) {
				return int64(value), true
			}
		case json.Number:
			parsed, err := value.Int64()
			if err == nil && parsed >= 0 {
				return parsed, true
			}
		case int64:
			if value >= 0 {
				return value, true
			}
		}
	}
	return 0, false
}

func optionalString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func envelopeIDValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableInt(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "unknown"
}

func (d *Daemon) acceptHook(request IPCRequest) IPCResponse {
	if request.Provider == "" || request.Event == "" {
		return IPCResponse{Version: protocolVersion, Code: "hook_identity_incomplete", Message: "provider and event are required"}
	}
	if request.Payload == nil {
		request.Payload = json.RawMessage(`{}`)
	}
	replica, err := d.state.ReplicaForPath(request.CWD)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "state_failed", Message: err.Error()}
	}
	if replica == nil {
		// Keep an unbound hook locally for diagnosis. It cannot be uploaded until
		// the user attaches the containing root, so the provider still receives a
		// fast successful hook response without losing the event.
		return d.spoolUnboundHook(request)
	}
	envelope, err := d.buildHookEnvelope(request, replica)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "hook_payload_invalid", Message: err.Error()}
	}
	if envelope.Type == "session_started" {
		go func() {
			prepareCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = d.prepareOnlinePermit(prepareCtx, replica.SpaceID, replica.ReplicaID)
		}()
	}
	if replica.MirrorMode == "disabled" {
		terminal := envelope.Type == "turn_stopped" || envelope.Type == "turn_failed" || envelope.Type == "session_ended" || envelope.Type == "provider_exited"
		attemptID := envelopeIDValue(envelope.ExecutionAttemptID)
		if terminal && attemptID != "" {
			eventID := envelope.EventID
			receipt, spoolErr := d.state.AppendSpool(eventID, mustJSON(spoolEnvelope{
				Kind:               "workspace_terminal",
				Version:            protocolVersion,
				EventID:            eventID,
				SpaceID:            replica.SpaceID,
				ReplicaID:          replica.ReplicaID,
				ExecutionAttemptID: attemptID,
			}))
			if spoolErr != nil {
				return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: spoolErr.Error()}
			}
			return IPCResponse{Version: protocolVersion, OK: true, Code: "mirror_disabled", EventID: eventID, LocalReceiptSeq: receipt, ExecutionAttemptID: attemptID, SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID, RelativeCWD: relativeCWD(replica.Root, request.CWD)}
		}
		return IPCResponse{Version: protocolVersion, OK: true, Code: "mirror_disabled", ExecutionAttemptID: attemptID, SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID, RelativeCWD: relativeCWD(replica.Root, request.CWD)}
	}
	eventID := envelope.EventID
	spooled, err := d.state.AppendSpool(eventID, mustJSON(spoolEnvelope{
		Kind:               "hook",
		Version:            protocolVersion,
		EventID:            eventID,
		SpaceID:            replica.SpaceID,
		ReplicaID:          replica.ReplicaID,
		ExecutionAttemptID: envelopeIDValue(envelope.ExecutionAttemptID),
		Hook:               mustJSON(envelope),
	}))
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: err.Error()}
	}
	envelope.LocalReceiptSequence = spooled
	if err := d.state.ReplaceSpoolPayload(spooled, mustJSON(spoolEnvelope{
		Kind:               "hook",
		Version:            protocolVersion,
		EventID:            eventID,
		SpaceID:            replica.SpaceID,
		ReplicaID:          replica.ReplicaID,
		ExecutionAttemptID: envelopeIDValue(envelope.ExecutionAttemptID),
		Hook:               mustJSON(envelope),
	})); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, EventID: eventID, LocalReceiptSeq: spooled, ExecutionAttemptID: envelopeIDValue(envelope.ExecutionAttemptID), SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID, RelativeCWD: relativeCWD(replica.Root, request.CWD)}
}

func (d *Daemon) acceptBundle(request IPCRequest) IPCResponse {
	if request.Bundle == nil || request.SpaceID == "" || request.ReplicaID == "" {
		return IPCResponse{Version: protocolVersion, Code: "bundle_identity_incomplete", Message: "spaceId, replicaId, and bundle are required"}
	}
	canonical, err := CanonicalJSON(request.Bundle)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "bundle_invalid", Message: err.Error()}
	}
	if len(canonical) > 256*1024*1024 {
		return IPCResponse{Version: protocolVersion, Code: "bundle_too_large", Message: "native bundle exceeds 256 MiB"}
	}
	eventID := uuid.NewString()
	var bundle struct {
		ExecutionAttemptID string `json:"executionAttemptId"`
	}
	if err := json.Unmarshal(canonical, &bundle); err != nil || bundle.ExecutionAttemptID == "" {
		return IPCResponse{Version: protocolVersion, Code: "bundle_invalid", Message: "bundle executionAttemptId is required"}
	}
	receipt, err := d.state.AppendSpool(eventID, mustJSON(spoolEnvelope{Kind: "bundle", Version: protocolVersion, EventID: eventID, SpaceID: request.SpaceID, ReplicaID: request.ReplicaID, ExecutionAttemptID: bundle.ExecutionAttemptID, Bundle: canonical}))
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, EventID: eventID, LocalReceiptSeq: receipt, ExecutionAttemptID: bundle.ExecutionAttemptID, SpaceID: request.SpaceID, ReplicaID: request.ReplicaID}
}

func (d *Daemon) spoolUnboundHook(request IPCRequest) IPCResponse {
	sanitized, err := sanitizePayload(request.Payload)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "hook_payload_invalid", Message: err.Error()}
	}
	eventID := uuid.NewString()
	payload := mustJSON(map[string]any{
		"kind":     "unbound_hook",
		"version":  protocolVersion,
		"eventId":  eventID,
		"provider": request.Provider,
		"event":    request.Event,
		"cwd":      request.CWD,
		"payload":  json.RawMessage(sanitized),
	})
	receipt, err := d.state.AppendSpool(eventID, payload)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: err.Error()}
	}
	return IPCResponse{Version: protocolVersion, OK: true, EventID: eventID, LocalReceiptSeq: receipt, Code: "unbound"}
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
		case "bundle":
			if len(envelope.Bundle) == 0 {
				continue
			}
			uploadErr = d.uploadBundle(ctx, envelope)
		case "hook":
			if len(envelope.Hook) == 0 {
				continue
			}
			uploadErr = d.uploadHook(ctx, envelope)
		case "workspace_terminal":
			uploadErr = d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID)
		default:
			// Unbound/emergency records stay local until a later attach or manual
			// export can establish their Space binding.
			continue
		}
		if uploadErr != nil {
			_ = d.state.MarkSpoolResult(item.Sequence, false, uploadErr.Error())
			continue
		}
		_ = d.state.MarkSpoolResult(item.Sequence, true, "")
	}
}

func (d *Daemon) accessToken() (string, error) {
	value, err := keyring.Get(keyringService, credentialAccessToken)
	if err == nil && strings.TrimSpace(value) != "" {
		return value, nil
	}
	token := strings.TrimSpace(d.cfg.AccessToken)
	if token != "" {
		return token, nil
	}
	return "", errors.New("local agent access token is unavailable")
}

func (d *Daemon) uploadHook(ctx context.Context, envelope spoolEnvelope) error {
	if d.apiBaseURL() == "" {
		return errors.New("COHUB_API_URL is not configured")
	}
	token, err := d.accessToken()
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/events/inline", d.apiBaseURL(), envelope.SpaceID, envelope.ReplicaID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(envelope.Hook))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("native event API returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var hook sanitizedHookEnvelope
	if json.Unmarshal(envelope.Hook, &hook) == nil && hook.ExecutionAttemptID != nil && (hook.Type == "turn_stopped" || hook.Type == "turn_failed" || hook.Type == "session_ended" || hook.Type == "provider_exited") {
		if err := d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, *hook.ExecutionAttemptID); err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) releaseExecutionPermit(ctx context.Context, spaceID, executionAttemptID string) error {
	permit, err := d.state.PermitContext(executionAttemptID)
	if err != nil {
		return err
	}
	if permit == nil || permit.SpaceID != spaceID || permit.Status == "completed" || (permit.Status == "expired" && !isAcpRuntimePermit(permit.HolderID)) || (permit.Status != "prepared" && permit.Status != "active" && permit.Status != "expired") {
		return nil
	}
	payload := mustJSON(map[string]any{
		"holderKind": permit.HolderKind,
		"holderId":   serverPermitHolderID(permit.HolderID),
		"epoch":      permit.LeaseEpoch,
	})
	if _, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/leases/release", d.apiBaseURL(), spaceID), payload, 2*1024*1024); err != nil {
		return err
	}
	if err := d.state.CompleteProviderAttemptsByExecution(executionAttemptID); err != nil {
		return err
	}
	return d.state.CompletePermit(executionAttemptID)
}

const nativeInlineBundleMaxBytes = 128 * 1024

type nativeIngestStatusResponse struct {
	IngestID       string `json:"ingestId"`
	SemanticStatus string `json:"semanticStatus"`
}

type nativeIngestPrepareResponse struct {
	IngestID  string            `json:"ingestId"`
	UploadURL string            `json:"uploadUrl"`
	Headers   map[string]string `json:"headers"`
	Status    string            `json:"status"`
}

func requireAppliedNativeIngest(body []byte) error {
	var result nativeIngestStatusResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return err
	}
	if result.SemanticStatus == "quarantined" {
		return errors.New("native ingest was quarantined; export or discard it explicitly")
	}
	if result.SemanticStatus != "applied" {
		return fmt.Errorf("native ingest is not semantically applied yet: %s", result.SemanticStatus)
	}
	return nil
}

func (d *Daemon) uploadBundle(ctx context.Context, envelope spoolEnvelope) error {
	if d.apiBaseURL() == "" {
		return errors.New("COHUB_API_URL is not configured")
	}
	payloadHash := hashCanonical(envelope.Bundle)
	if payloadHash == "" {
		return errors.New("native bundle canonical hash is invalid")
	}
	apiBase := d.apiBaseURL()
	if len(envelope.Bundle) <= nativeInlineBundleMaxBytes {
		body, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/ingests/inline", apiBase, envelope.SpaceID, envelope.ReplicaID), mustJSON(map[string]any{
			"version":           1,
			"bindingId":         nil,
			"nativeAgentTurnId": nil,
			"bundle":            json.RawMessage(envelope.Bundle),
			"payloadSha256":     payloadHash,
		}), 2*1024*1024)
		if err != nil {
			return err
		}
		if err := requireAppliedNativeIngest(body); err != nil {
			return err
		}
		return d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID)
	}

	var identity struct {
		ExecutionAttemptID     string `json:"executionAttemptId"`
		BundleID               string `json:"bundleId"`
		Provider               string `json:"provider"`
		ProviderVersion        string `json:"providerVersion"`
		AdapterVersion         string `json:"adapterVersion"`
		NativeSessionKey       string `json:"nativeSessionKey"`
		NativeTurnKey          string `json:"nativeTurnKey"`
		WorkspacePolicyVersion int64  `json:"workspacePolicyVersion"`
		IntegrationVersion     int64  `json:"integrationPolicyVersion"`
		SessionMirrorMode      string `json:"sessionMirrorMode"`
	}
	if err := json.Unmarshal(envelope.Bundle, &identity); err != nil {
		return err
	}
	if identity.ExecutionAttemptID == "" || identity.BundleID == "" || identity.Provider == "" || identity.NativeSessionKey == "" || identity.NativeTurnKey == "" {
		return errors.New("native bundle identity is incomplete")
	}
	prepareBody, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/ingests/prepare", apiBase, envelope.SpaceID, envelope.ReplicaID), mustJSON(map[string]any{
		"version":                  1,
		"executionAttemptId":       identity.ExecutionAttemptID,
		"bindingId":                nil,
		"nativeAgentTurnId":        nil,
		"bundleId":                 identity.BundleID,
		"payloadSha256":            payloadHash,
		"payloadBytes":             len(envelope.Bundle),
		"provider":                 identity.Provider,
		"providerVersion":          firstNonEmpty(identity.ProviderVersion, "unknown"),
		"adapterVersion":           firstNonEmpty(identity.AdapterVersion, "locald-hook-v1"),
		"nativeSessionKey":         identity.NativeSessionKey,
		"nativeTurnKey":            identity.NativeTurnKey,
		"workspacePolicyVersion":   identity.WorkspacePolicyVersion,
		"integrationPolicyVersion": identity.IntegrationVersion,
		"sessionMirrorMode":        identity.SessionMirrorMode,
	}), 2*1024*1024)
	if err != nil {
		return err
	}
	var prepared nativeIngestPrepareResponse
	if err := json.Unmarshal(prepareBody, &prepared); err != nil {
		return err
	}
	if prepared.IngestID == "" {
		return errors.New("native ingest prepare returned no ingest id")
	}
	if prepared.Status == "applied" {
		return d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID)
	}
	if prepared.Status == "quarantined" {
		return errors.New("native ingest was quarantined; export or discard it explicitly")
	}
	if prepared.Status == "prepared" {
		if prepared.UploadURL == "" {
			return errors.New("native ingest prepare returned no upload URL")
		}
		if err := d.putSignedBytes(ctx, prepared.UploadURL, prepared.Headers, envelope.Bundle); err != nil {
			return fmt.Errorf("upload native bundle: %w", err)
		}
	}
	commitBody, err := d.request(ctx, http.MethodPost, fmt.Sprintf("%s/api/local-agent/spaces/%s/replicas/%s/ingests/%s/commit", apiBase, envelope.SpaceID, envelope.ReplicaID, prepared.IngestID), []byte(`{}`), 2*1024*1024)
	if err != nil {
		return err
	}
	if err := requireAppliedNativeIngest(commitBody); err != nil {
		return err
	}
	return d.finalizeExecutionWorkspace(ctx, envelope.SpaceID, envelope.ReplicaID, envelope.ExecutionAttemptID)
}

func hashCanonical(raw []byte) string {
	hash, _, err := CanonicalHash(raw)
	if err != nil {
		return ""
	}
	return hash
}

func providerIdentityScope(key string) string {
	normalized := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
	switch normalized {
	case "sessionid", "conversationid", "threadid":
		return "session"
	case "turnid", "promptid":
		return "turn"
	case "messageid", "responseid":
		return "message"
	case "toolcallid":
		return "tool"
	default:
		return ""
	}
}

func pathMetadataKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
	return normalized == "cwd" || strings.Contains(normalized, "transcriptpath") || strings.Contains(normalized, "sessionpath") || strings.Contains(normalized, "configpath") || strings.Contains(normalized, "providerhome")
}

func absolutePathLike(value string) bool {
	trimmed := strings.TrimSpace(value)
	return filepath.IsAbs(trimmed) || strings.HasPrefix(trimmed, `\\`) || (len(trimmed) >= 3 && ((trimmed[0] >= 'A' && trimmed[0] <= 'Z') || (trimmed[0] >= 'a' && trimmed[0] <= 'z')) && trimmed[1] == ':' && (trimmed[2] == '\\' || trimmed[2] == '/'))
}

func sanitizeProviderPayloadIdentifiers(value any, identity []byte, spaceID, replicaID, provider string) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, nested := range typed {
			if scope := providerIdentityScope(key); scope != "" {
				if raw, ok := nested.(string); ok && strings.TrimSpace(raw) != "" {
					result["native"+strings.ToUpper(scope[:1])+scope[1:]+"Key"] = ScopedIdentity(identity, scope, provider, scopedUploadIdentity(spaceID, replicaID, raw))
				}
				continue
			}
			if pathMetadataKey(key) {
				if raw, ok := nested.(string); ok && absolutePathLike(raw) {
					result[key] = "[redacted-path]"
					continue
				}
			}
			result[key] = sanitizeProviderPayloadIdentifiers(nested, identity, spaceID, replicaID, provider)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, nested := range typed {
			result[index] = sanitizeProviderPayloadIdentifiers(nested, identity, spaceID, replicaID, provider)
		}
		return result
	default:
		return typed
	}
}

func metadataOnlyHookPayload(payload map[string]any) map[string]any {
	result := map[string]any{"payloadSha256": hashCanonical(mustJSON(payload))}
	for _, key := range []string{"status", "reason", "isError", "exitCode", "toolName"} {
		value, exists := payload[key]
		if !exists {
			continue
		}
		switch value.(type) {
		case string, bool, float64, json.Number:
			result[key] = value
		}
	}
	return result
}

func sanitizePayload(raw []byte) (json.RawMessage, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	clean, err := sanitizeValue(value, 0)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(clean)
	if err != nil {
		return nil, err
	}
	if len(encoded) > 64*1024 {
		return nil, errors.New("hook payload exceeds 64 KiB")
	}
	return encoded, nil
}

func sanitizeValue(value any, depth int) (any, error) {
	if depth > 8 {
		return nil, errors.New("hook payload nesting is too deep")
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, nested := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "authorization") || strings.Contains(lower, "api_key") || strings.Contains(lower, "private_key") {
				result[key] = "[redacted]"
				continue
			}
			clean, err := sanitizeValue(nested, depth+1)
			if err != nil {
				return nil, err
			}
			result[key] = clean
		}
		return result, nil
	case []any:
		result := make([]any, len(typed))
		for index, nested := range typed {
			clean, err := sanitizeValue(nested, depth+1)
			if err != nil {
				return nil, err
			}
			result[index] = clean
		}
		return result, nil
	case json.Number:
		return typed.String(), nil
	default:
		return typed, nil
	}
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
