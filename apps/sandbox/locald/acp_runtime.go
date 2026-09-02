package locald

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/cohub/apps/sandbox/relay"
)

// AcpRuntimeOptions configures a local ACP runtime. The runtime process is a
// thin transport adapter: the provider owns its tools and session state, while
// locald forwards ACP JSON-RPC messages without interpreting provider payloads.
type AcpRuntimeOptions struct {
	RelayURL        string
	RelayToken      string
	DeviceID        string
	RuntimeID       string
	SpaceID         string
	ReplicaID       string
	Provider        string
	ProviderCommand string
	ProviderArgs    []string
	WorkspaceDir    string
	DataDir         string
	APIBaseURL      string
	Logger          *slog.Logger
}

type acpRuntimeServer struct {
	options        AcpRuntimeOptions
	finalizer      *Daemon
	attemptMu      sync.Mutex
	activeAttempts map[string]struct{}
}

// RunAcpRuntime keeps a local provider ACP adapter connected to the Gateway
// runtime relay until ctx is cancelled. Each paired data channel gets its own
// provider process, matching ACP's connection-scoped lifecycle.
func RunAcpRuntime(ctx context.Context, options AcpRuntimeOptions) error {
	if strings.TrimSpace(options.RelayURL) == "" {
		return errors.New("ACP runtime relay url is required")
	}
	if strings.TrimSpace(options.RelayToken) == "" {
		return errors.New("ACP runtime relay token is required")
	}
	if strings.TrimSpace(options.RuntimeID) == "" || strings.TrimSpace(options.SpaceID) == "" || strings.TrimSpace(options.ReplicaID) == "" {
		return errors.New("ACP runtime identity is required")
	}
	for name, value := range map[string]string{
		"runtimeId": options.RuntimeID,
		"spaceId":   options.SpaceID,
		"replicaId": options.ReplicaID,
	} {
		if _, err := uuid.Parse(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("ACP runtime %s must be a UUID", name)
		}
	}
	if strings.TrimSpace(options.Provider) == "" {
		return errors.New("ACP runtime provider is required")
	}
	if strings.TrimSpace(options.WorkspaceDir) == "" {
		return errors.New("ACP runtime workspace directory is required")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if strings.TrimSpace(options.ProviderCommand) == "" {
		options.ProviderCommand = defaultAcpProviderCommand(options.Provider)
	}
	if strings.TrimSpace(options.ProviderCommand) == "" {
		return fmt.Errorf("no ACP adapter command is configured for provider %q", options.Provider)
	}
	if _, err := exec.LookPath(options.ProviderCommand); err != nil {
		return fmt.Errorf("ACP adapter command %q is not available: %w", options.ProviderCommand, err)
	}

	workspaceDir, err := CanonicalWorkspaceRoot(options.WorkspaceDir)
	if err != nil {
		return fmt.Errorf("canonicalize ACP runtime workspace: %w", err)
	}
	workspaceInfo, err := os.Stat(workspaceDir)
	if err != nil || !workspaceInfo.IsDir() {
		if err != nil {
			return fmt.Errorf("ACP runtime workspace is unavailable: %w", err)
		}
		return errors.New("ACP runtime workspace must be a directory")
	}
	options.WorkspaceDir = workspaceDir
	dataDir := strings.TrimSpace(options.DataDir)
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	// The regular locald daemon owns apply-journal recovery. Runtime mode may
	// share its SQLite state, so it must not call NewDaemon and race a live
	// journal rollback; it only provides the finalization/retry client.
	state, err := OpenState(dataDir)
	if err != nil {
		return fmt.Errorf("open local ACP runtime state: %w", err)
	}
	finalizer := &Daemon{
		cfg: Config{
			DataDir:       dataDir,
			DeviceID:      strings.TrimSpace(options.DeviceID),
			AccessToken:   strings.TrimSpace(options.RelayToken),
			APIBaseURL:    strings.TrimSpace(options.APIBaseURL),
			PollInterval:  5 * time.Second,
			HTTPTimeout:   30 * time.Second,
			DaemonVersion: "local-acp-runtime",
		},
		state:  state,
		client: &http.Client{Timeout: 30 * time.Second},
	}
	replica, err := state.ReplicaForSpace(options.SpaceID)
	if err != nil {
		_ = state.Close()
		return fmt.Errorf("read ACP runtime workspace binding: %w", err)
	}
	deviceID := strings.TrimSpace(options.DeviceID)
	if deviceID == "" {
		deviceID, _ = LoadCredential(credentialDeviceID)
	}
	if strings.TrimSpace(deviceID) == "" {
		_ = state.Close()
		return errors.New("ACP runtime device identity is unavailable")
	}
	deviceID = strings.TrimSpace(deviceID)
	options.DeviceID = deviceID
	finalizer.cfg.DeviceID = deviceID
	if replica == nil || replica.ReplicaID != options.ReplicaID || replica.DeviceID != deviceID || filepath.Clean(replica.Root) != filepath.Clean(workspaceDir) {
		_ = state.Close()
		return errors.New("ACP runtime workspace does not match the attached local replica")
	}
	if replica.Status != "ready" || replica.AppliedSnapshotID == "" {
		_ = state.Close()
		return errors.New("ACP runtime local replica is not ready")
	}
	defer finalizer.Close()
	refreshCtx, cancelRefresh := context.WithTimeout(ctx, 30*time.Second)
	if err := finalizer.refreshAccessToken(refreshCtx); err == nil {
		if refreshed, credentialErr := finalizer.accessToken(); credentialErr == nil && strings.TrimSpace(refreshed) != "" {
			options.RelayToken = refreshed
		}
	} else {
		options.Logger.Debug("local ACP runtime token refresh skipped", slog.String("error", err.Error()))
	}
	cancelRefresh()
	server := &acpRuntimeServer{options: options, finalizer: finalizer, activeAttempts: make(map[string]struct{})}
	initialRelayToken := strings.TrimSpace(options.RelayToken)
	// Runtime mode is often launched as a separate process from the regular
	// locald daemon. Keep the shared spool, permit heartbeat, and workspace sync
	// loop alive here as well so a finalize failure remains recoverable.
	var maintenance sync.WaitGroup
	maintenance.Add(2)
	go func() {
		defer maintenance.Done()
		finalizer.replayLoop(ctx)
	}()
	go func() {
		defer maintenance.Done()
		finalizer.heartbeatAcpPermits(ctx, server.isAttemptActive)
	}()
	client := relay.NewClient(relay.Options{
		RelayURL: options.RelayURL,
		Token:    options.RelayToken,
		TokenProvider: func(tokenCtx context.Context) (string, error) {
			if refreshErr := finalizer.refreshAccessToken(tokenCtx); refreshErr != nil {
				// A still-valid cached token is useful during a temporary API outage;
				// the relay will retry with a refreshed token on the next connection.
				if cached, accessErr := finalizer.accessToken(); accessErr == nil && strings.TrimSpace(cached) != "" {
					return strings.TrimSpace(cached), nil
				}
				if initialRelayToken != "" {
					return initialRelayToken, nil
				}
				return "", refreshErr
			}
			return finalizer.accessToken()
		},
		SpaceID:       options.SpaceID,
		Kind:          "runtime",
		RuntimeID:     options.RuntimeID,
		Provider:      options.Provider,
		RuntimeServer: server,
		Logger:        options.Logger,
	})
	options.Logger.Info("local ACP runtime starting",
		slog.String("runtimeId", options.RuntimeID),
		slog.String("spaceId", options.SpaceID),
		slog.String("replicaId", options.ReplicaID),
		slog.String("provider", options.Provider),
		slog.String("workspaceDir", options.WorkspaceDir),
		slog.String("adapterCommand", options.ProviderCommand),
	)
	client.Run(ctx)
	maintenance.Wait()
	return nil
}

func defaultAcpProviderCommand(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "pi":
		return "pi-acp"
	case "codex":
		return "codex-acp"
	case "claude_code", "claude-code", "claude":
		return "claude-agent-acp"
	default:
		return ""
	}
}

func (s *acpRuntimeServer) ServeDialedConn(parent context.Context, conn *websocket.Conn, remote string) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "runtime session closed")

	command := strings.TrimSpace(s.options.ProviderCommand)
	cmd := exec.CommandContext(ctx, command, s.options.ProviderArgs...)
	cmd.Dir = s.options.WorkspaceDir
	cmd.Env = sanitizedRuntimeEnvironment(os.Environ())
	configureAcpProviderProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.options.Logger.Warn("ACP provider stdin unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		s.options.Logger.Warn("ACP provider stdout unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		s.options.Logger.Warn("ACP provider stderr unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	if err := cmd.Start(); err != nil {
		s.options.Logger.Warn("ACP provider failed to start", slog.String("command", command), slog.String("error", err.Error()))
		return
	}
	s.options.Logger.Info("ACP provider started", slog.String("remote", remote), slog.String("command", command), slog.Int("pid", cmd.Process.Pid))

	var once sync.Once
	processWaitDone := make(chan struct{})
	closeProvider := func() {
		once.Do(func() {
			_ = stdin.Close()
			if cmd.Process == nil {
				return
			}
			_ = terminateAcpProviderProcess(cmd)
			go func() {
				timer := time.NewTimer(2 * time.Second)
				defer timer.Stop()
				select {
				case <-processWaitDone:
				case <-timer.C:
					_ = cmd.Process.Kill()
				}
			}()
		})
	}

	var promptMu sync.Mutex
	pendingPrompts := make(map[string]runtimeAttemptRef)
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		if err := forwardAcpStdout(ctx, conn, stdout, s.options.WorkspaceDir, &promptMu, pendingPrompts, s.finishAttempt); err != nil && !errors.Is(err, context.Canceled) {
			s.options.Logger.Debug("ACP provider output forwarding ended", slog.String("remote", remote), slog.String("error", err.Error()))
		}
		cancel()
	}()
	go func() {
		defer workers.Done()
		if err := forwardAcpStdin(ctx, conn, stdin, s.options.WorkspaceDir, s.options.RuntimeID, s.options.SpaceID, s.options.ReplicaID, &promptMu, pendingPrompts, s.startAttempt, s.finishAttempt); err != nil && !errors.Is(err, context.Canceled) {
			s.options.Logger.Debug("ACP provider input forwarding ended", slog.String("remote", remote), slog.String("error", err.Error()))
		}
		cancel()
	}()
	go func() {
		defer workers.Done()
		// stderr is diagnostic output; its pipe may be closed independently of
		// the ACP transport and must not terminate a live provider session.
		copyRuntimeStderr(s.options.Logger, stderr, remote)
	}()

	<-ctx.Done()
	closeProvider()
	_ = conn.Close(websocket.StatusNormalClosure, "runtime session ended")
	workers.Wait()
	if err := cmd.Wait(); err != nil && ctx.Err() == nil {
		s.options.Logger.Debug("ACP provider exited with error", slog.String("remote", remote), slog.String("error", err.Error()))
	}
	close(processWaitDone)
	// A provider crash or a relay disconnect can leave a prompt without its
	// normal JSON-RPC response. Preserve durable finalization evidence so the
	// replay loop can reconcile the local workspace after connectivity returns.
	promptMu.Lock()
	unresolved := make([]runtimeAttemptRef, 0, len(pendingPrompts))
	for id, ref := range pendingPrompts {
		delete(pendingPrompts, id)
		unresolved = append(unresolved, ref)
	}
	promptMu.Unlock()
	for _, ref := range unresolved {
		s.finishAttempt(ref)
	}
}

type runtimeAttemptRef struct {
	attemptID      string
	spaceID        string
	replicaID      string
	baseSnapshotID string
	leaseEpoch     int64
	expiresAt      time.Time
}

func runtimeAttemptRefFromMetadata(meta map[string]any, runtimeID, runtimeSpaceID, runtimeReplicaID string) (runtimeAttemptRef, error) {
	attemptID := stringValue(meta["cohubExecutionAttemptId"])
	spaceID := stringValue(meta["cohubSpaceId"])
	replicaID := stringValue(meta["cohubReplicaId"])
	metadataRuntimeID := stringValue(meta["cohubRuntimeId"])
	baseSnapshotID := stringValue(meta["cohubBaseSnapshotId"])
	leaseEpoch := int64Value(meta["cohubLeaseEpoch"], 0)
	expiresAt, err := time.Parse(time.RFC3339Nano, stringValue(meta["cohubLeaseExpiresAt"]))
	if err != nil || !expiresAt.After(time.Now().UTC()) {
		return runtimeAttemptRef{}, errors.New("session/prompt workspace lease expiry is invalid")
	}
	if attemptID == "" || spaceID == "" || replicaID == "" || baseSnapshotID == "" || leaseEpoch < 1 {
		return runtimeAttemptRef{}, errors.New("session/prompt is missing Cohub workspace binding")
	}
	if runtimeID != "" && metadataRuntimeID != runtimeID {
		return runtimeAttemptRef{}, errors.New("session/prompt runtime does not match the registered runtime")
	}
	if runtimeSpaceID != "" && spaceID != runtimeSpaceID {
		return runtimeAttemptRef{}, errors.New("session/prompt Space does not match the registered runtime")
	}
	if runtimeReplicaID != "" && replicaID != runtimeReplicaID {
		return runtimeAttemptRef{}, errors.New("session/prompt replica does not match the registered runtime")
	}
	for _, value := range []struct{ name, id string }{
		{"cohubExecutionAttemptId", attemptID},
		{"cohubSpaceId", spaceID},
		{"cohubReplicaId", replicaID},
	} {
		if _, err := uuid.Parse(value.id); err != nil {
			return runtimeAttemptRef{}, fmt.Errorf("%s is not a UUID", value.name)
		}
	}
	if _, err := uuid.Parse(baseSnapshotID); err != nil {
		return runtimeAttemptRef{}, errors.New("cohubBaseSnapshotId is not a UUID")
	}
	return runtimeAttemptRef{
		attemptID:      attemptID,
		spaceID:        spaceID,
		replicaID:      replicaID,
		baseSnapshotID: baseSnapshotID,
		leaseEpoch:     leaseEpoch,
		expiresAt:      expiresAt,
	}, nil
}

func (s *acpRuntimeServer) startAttempt(ref runtimeAttemptRef) error {
	if s.finalizer == nil || ref.attemptID == "" || ref.spaceID == "" || ref.replicaID == "" || ref.leaseEpoch < 1 {
		return errors.New("ACP prompt has incomplete workspace lease provenance")
	}
	if !ref.expiresAt.After(time.Now().UTC()) {
		return errors.New("ACP prompt workspace lease has expired")
	}
	if err := s.finalizer.state.ClaimAcpRuntimePermit(ref.attemptID, ref.spaceID, ref.replicaID, ref.baseSnapshotID, ref.leaseEpoch, ref.expiresAt); err != nil {
		s.options.Logger.Warn("claim ACP runtime permit failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
		return fmt.Errorf("claim ACP runtime permit: %w", err)
	}
	s.attemptMu.Lock()
	if s.activeAttempts == nil {
		s.activeAttempts = make(map[string]struct{})
	}
	s.activeAttempts[ref.attemptID] = struct{}{}
	s.attemptMu.Unlock()
	return nil
}

func (s *acpRuntimeServer) isAttemptActive(attemptID string) bool {
	s.attemptMu.Lock()
	defer s.attemptMu.Unlock()
	_, ok := s.activeAttempts[attemptID]
	return ok
}

func (s *acpRuntimeServer) finishAttempt(ref runtimeAttemptRef) {
	s.attemptMu.Lock()
	delete(s.activeAttempts, ref.attemptID)
	s.attemptMu.Unlock()
	if s.finalizer == nil || ref.attemptID == "" || ref.spaceID == "" || ref.replicaID == "" {
		return
	}
	// Persist terminal evidence before any network call. The regular daemon or
	// this runtime's replay loop will perform the idempotent finalization.
	eventID := "workspace-terminal:" + ref.attemptID
	payload := mustJSON(spoolEnvelope{
		Kind:               "workspace_terminal",
		Version:            protocolVersion,
		EventID:            eventID,
		SpaceID:            ref.spaceID,
		ReplicaID:          ref.replicaID,
		ExecutionAttemptID: ref.attemptID,
	})
	if _, err := s.finalizer.state.AppendSpool(eventID, payload); err != nil {
		s.options.Logger.Error("queue ACP workspace finalization failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
	}
}

func acpRequestIDKey(value any) string {
	encoded, err := json.Marshal(value)
	if err == nil {
		return string(encoded)
	}
	return fmt.Sprintf("%T:%v", value, value)
}

func validAcpRequestID(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) != ""
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0)
	default:
		return false
	}
}

func forwardAcpStdout(ctx context.Context, conn *websocket.Conn, output io.Reader, workspaceDir string, promptMu *sync.Mutex, pending map[string]runtimeAttemptRef, finish func(runtimeAttemptRef)) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytesTrimSpace(line)) == 0 {
			continue
		}
		if !json.Valid(line) {
			return errors.New("ACP provider sent invalid JSON")
		}
		var value map[string]any
		if err := json.Unmarshal(line, &value); err != nil {
			return fmt.Errorf("decode ACP provider message: %w", err)
		}
		if value == nil {
			return errors.New("ACP provider message must be a JSON object")
		}
		if value["jsonrpc"] != "2.0" {
			return errors.New("ACP provider message has an unsupported JSON-RPC version")
		}
		value = rewriteAcpPaths(value, workspaceDir)
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encode ACP provider message: %w", err)
		}
		var completed *runtimeAttemptRef
		if _, ok := value["method"]; !ok {
			if id, ok := value["id"]; ok {
				key := acpRequestIDKey(id)
				promptMu.Lock()
				ref, found := pending[key]
				if found {
					delete(pending, key)
				}
				promptMu.Unlock()
				if found {
					completed = &ref
				}
			}
		}
		if completed != nil {
			finish(*completed)
		}
		if err := conn.Write(ctx, websocket.MessageText, append(append([]byte(nil), encoded...), '\n')); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func forwardAcpStdin(ctx context.Context, conn *websocket.Conn, input io.Writer, workspaceDir, runtimeID, runtimeSpaceID, runtimeReplicaID string, promptMu *sync.Mutex, pending map[string]runtimeAttemptRef, begin func(runtimeAttemptRef) error, finish func(runtimeAttemptRef)) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		trimmed := bytesTrimSpace(data)
		if len(trimmed) == 0 {
			continue
		}
		if !json.Valid(trimmed) {
			return errors.New("ACP client sent invalid JSON")
		}
		var value map[string]any
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return fmt.Errorf("decode ACP client message: %w", err)
		}
		if value == nil {
			return errors.New("ACP client message must be a JSON object")
		}
		if value["jsonrpc"] != "2.0" {
			return errors.New("ACP client message has an unsupported JSON-RPC version")
		}
		rawMethod, methodPresent := value["method"]
		method, methodIsString := rawMethod.(string)
		_, hasID := value["id"]
		if !methodPresent && !hasID {
			return errors.New("ACP client message has neither method nor id")
		}
		if methodPresent && (!methodIsString || strings.TrimSpace(method) == "") {
			return errors.New("ACP client message method is invalid")
		}
		params, _ := value["params"].(map[string]any)
		if params == nil {
			params = map[string]any{}
		}
		delete(value, "_meta")
		if method == "session/new" || method == "session/load" || method == "session/resume" {
			params["cwd"] = workspaceDir
			// Cohub does not provide or broker MCP servers. ACP requires this
			// field on lifecycle requests, so normalize it to an empty list.
			params["mcpServers"] = []any{}
			// Do not widen the provider's filesystem scope beyond the bound
			// materialized replica.
			delete(params, "additionalDirectories")
			// Cohub binding metadata is transport-only and never belongs in the
			// provider's native session journal.
			delete(params, "_meta")
			value["params"] = params
		}
		if method == "session/prompt" {
			id, hasID := value["id"]
			if !hasID || !validAcpRequestID(id) {
				if !hasID {
					continue
				}
				if err := writeAcpError(ctx, conn, id, -32600, "session/prompt requires a JSON-RPC request id"); err != nil {
					return err
				}
				continue
			}
			meta, _ := params["_meta"].(map[string]any)
			if meta == nil {
				if err := writeAcpError(ctx, conn, id, -32001, "session/prompt is missing Cohub workspace binding"); err != nil {
					return err
				}
				continue
			}
			ref, err := runtimeAttemptRefFromMetadata(meta, runtimeID, runtimeSpaceID, runtimeReplicaID)
			if err != nil {
				if writeErr := writeAcpError(ctx, conn, id, -32001, err.Error()); writeErr != nil {
					return writeErr
				}
				continue
			}
			promptMu.Lock()
			busy := len(pending) > 0
			promptMu.Unlock()
			if busy {
				if writeErr := writeAcpError(ctx, conn, id, -32002, "local ACP runtime already has an active prompt"); writeErr != nil {
					return writeErr
				}
				continue
			}
			if err := begin(ref); err != nil {
				if writeErr := writeAcpError(ctx, conn, id, -32001, err.Error()); writeErr != nil {
					return writeErr
				}
				continue
			}
			// The binding metadata is for locald's fencing decision only. Never
			// expose Cohub identifiers to the provider or its native journal.
			delete(params, "_meta")
			value["params"] = params
			promptMu.Lock()
			pending[acpRequestIDKey(id)] = ref
			promptMu.Unlock()
		}
		if method != "session/prompt" {
			if _, hasParams := value["params"]; hasParams {
				delete(params, "_meta")
				if method != "session/new" && method != "session/load" && method != "session/resume" {
					delete(params, "mcpServers")
				}
				delete(params, "additionalDirectories")
				value["params"] = params
			}
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("encode ACP client message: %w", err)
		}
		if _, err := input.Write(append(append([]byte(nil), encoded...), '\n')); err != nil {
			if id, ok := value["id"]; ok {
				promptMu.Lock()
				key := acpRequestIDKey(id)
				ref, found := pending[key]
				if found {
					delete(pending, key)
				}
				promptMu.Unlock()
				if found {
					finish(ref)
				}
			}
			return err
		}
	}
}

func writeAcpError(ctx context.Context, conn *websocket.Conn, id any, code int, message string) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, append(payload, '\n'))
}

func copyRuntimeStderr(logger *slog.Logger, input io.Reader, remote string) {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 8*1024), 512*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			logger.Debug("ACP provider stderr", slog.String("remote", remote), slog.String("line", line))
		}
	}
}

func sanitizedRuntimeEnvironment(input []string) []string {
	result := make([]string, 0, len(input))
	for _, entry := range input {
		key, _, _ := strings.Cut(entry, "=")
		upperKey := strings.ToUpper(key)
		if strings.HasPrefix(upperKey, "COHUB_") ||
			strings.HasPrefix(upperKey, "WORKER_") ||
			strings.HasPrefix(upperKey, "GATEWAY_") ||
			strings.HasPrefix(upperKey, "INTERNAL_API_") ||
			strings.HasPrefix(upperKey, "SANDBOX_") ||
			upperKey == "API_BASE_URL" ||
			upperKey == "DATABASE_URL" ||
			upperKey == "REDIS_URL" ||
			upperKey == "BULLMQ_REDIS_URL" ||
			upperKey == "APP_ENCRYPTION_KEY" ||
			upperKey == "LITELLM_API_KEY" {
			continue
		}
		result = append(result, entry)
	}
	return result
}

func rewriteAcpPaths(value map[string]any, workspaceDir string) map[string]any {
	root := filepath.ToSlash(filepath.Clean(workspaceDir))
	var rewrite func(key string, value any) any
	rewrite = func(key string, value any) any {
		switch typed := value.(type) {
		case string:
			if key != "path" && key != "cwd" && key != "uri" && key != "oldPath" && key != "newPath" && key != "directory" && key != "root" {
				return typed
			}
			path := strings.TrimPrefix(typed, "file://")
			path = filepath.ToSlash(path)
			if len(path) >= 3 && path[0] == '/' && path[2] == ':' {
				path = path[1:]
			}
			if strings.HasPrefix(path, "/") || (len(path) > 2 && path[1] == ':') {
				path = filepath.ToSlash(filepath.Clean(path))
			}
			if path == ".." || strings.HasPrefix(path, "../") || strings.Contains(path, "/../") {
				return "/workspace"
			}
			caseInsensitive := filepath.VolumeName(root) != ""
			equalRoot := path == root || (caseInsensitive && strings.EqualFold(path, root))
			withinRoot := strings.HasPrefix(path, root+"/") || (caseInsensitive && strings.HasPrefix(strings.ToLower(path), strings.ToLower(root)+"/"))
			if path == "/workspace" || strings.HasPrefix(path, "/workspace/") {
				return typed
			}
			if equalRoot {
				return "/workspace"
			}
			if withinRoot {
				relative := path[len(root)+1:]
				return "/workspace/" + relative
			}
			if strings.HasPrefix(path, "/") || (len(path) > 2 && path[1] == ':') {
				return "/workspace"
			}
			return typed
		case map[string]any:
			for childKey, child := range typed {
				typed[childKey] = rewrite(childKey, child)
			}
			return typed
		case []any:
			for index, child := range typed {
				typed[index] = rewrite(key, child)
			}
			return typed
		default:
			return value
		}
	}
	result := make(map[string]any, len(value))
	for key, child := range value {
		result[key] = rewrite(key, child)
	}
	return result
}

func stringValue(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func bytesTrimSpace(value []byte) []byte {
	return []byte(strings.TrimSpace(string(value)))
}
