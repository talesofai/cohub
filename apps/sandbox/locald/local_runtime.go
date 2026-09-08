package locald

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/cohub/apps/sandbox/relay"
)

// LocalRuntimeOptions configures a local runtime host. The host owns the
// provider SDK and session state; locald only fences the workspace and forwards
// provider-neutral local-runtime frames.
type LocalRuntimeOptions struct {
	RelayURL   string
	RelayToken string
	DeviceID   string
	RuntimeID  string
	SpaceID    string
	ReplicaID  string
	// ConnectionEpoch fences commands to the authorized relay connection. It is
	// supplied per channel because a runtime registration may be replaced while
	// the locald process remains alive.
	ConnectionEpoch int64
	// ExecutionAttemptID is supplied per channel and pins the host process to
	// the workspace lease that authorized that channel.
	ExecutionAttemptID string
	Provider           string
	ProviderCommand    string
	ProviderArgs       []string
	WorkspaceDir       string
	DataDir            string
	APIBaseURL         string
	Logger             *slog.Logger
}

type localRuntimeServer struct {
	options        LocalRuntimeOptions
	finalizer      *Daemon
	attemptMu      sync.Mutex
	activeAttempts map[string]struct{}
	// channelMu serializes provider channels. One runtime owns one local
	// replica and one native session journal, so a second data channel must
	// wait for the first host process to exit rather than run beside it.
	channelMu sync.Mutex
}

const (
	// The regular locald daemon polls the API on a five-second cadence. A
	// runtime started immediately after `configure` therefore needs to tolerate
	// the SQLite replica state still being `attaching` or `syncing`.
	localRuntimeReplicaReadyTimeout = 2 * time.Minute
	localRuntimeReplicaPollInterval = 100 * time.Millisecond
)

// localRuntimeMessageLimit matches the Agent transport's per-message bound.
// A runtime channel carries newline-delimited JSON, but the relay preserves
// WebSocket message boundaries and a peer can otherwise send an unbounded
// frame before the line scanner gets a chance to reject it.
const localRuntimeMessageLimit = 32 * 1024 * 1024

// RunLocalRuntime keeps a local runtime host connected to the Gateway relay
// until ctx is cancelled. Each paired data channel gets its own host process,
// matching the connection-scoped runtime lifecycle.
func RunLocalRuntime(ctx context.Context, options LocalRuntimeOptions) error {
	if strings.TrimSpace(options.RelayURL) == "" {
		return errors.New("local runtime relay url is required")
	}
	if strings.TrimSpace(options.RelayToken) == "" {
		return errors.New("local runtime relay token is required")
	}
	if strings.TrimSpace(options.RuntimeID) == "" || strings.TrimSpace(options.SpaceID) == "" || strings.TrimSpace(options.ReplicaID) == "" {
		return errors.New("local runtime identity is required")
	}
	for name, value := range map[string]string{
		"runtimeId": options.RuntimeID,
		"spaceId":   options.SpaceID,
		"replicaId": options.ReplicaID,
	} {
		if _, err := uuid.Parse(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("local runtime %s must be a UUID", name)
		}
	}
	options.Provider = normalizeRuntimeProvider(options.Provider)
	if options.Provider == "" {
		return errors.New("local runtime provider is required")
	}
	if strings.TrimSpace(options.WorkspaceDir) == "" {
		return errors.New("local runtime workspace directory is required")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if strings.TrimSpace(options.ProviderCommand) == "" {
		options.ProviderCommand = defaultProviderCommand(options.Provider)
	}
	if strings.TrimSpace(options.ProviderCommand) == "" {
		return fmt.Errorf("no local runtime host command is configured for provider %q", options.Provider)
	}
	resolvedCommand, resolvedArgs, err := resolveRuntimeHostCommand(options.ProviderCommand, options.ProviderArgs, runtime.GOOS, os.Getenv("COHUB_NODE_EXECUTABLE"))
	if err != nil {
		return err
	}
	if _, err := exec.LookPath(resolvedCommand); err != nil {
		return fmt.Errorf("local runtime host command %q is not available: %w", resolvedCommand, err)
	}
	options.ProviderCommand = resolvedCommand
	options.ProviderArgs = resolvedArgs

	workspaceDir, err := CanonicalWorkspaceRoot(options.WorkspaceDir)
	if err != nil {
		return fmt.Errorf("canonicalize local runtime workspace: %w", err)
	}
	workspaceInfo, err := os.Stat(workspaceDir)
	if err != nil || !workspaceInfo.IsDir() {
		if err != nil {
			return fmt.Errorf("local runtime workspace is unavailable: %w", err)
		}
		return errors.New("local runtime workspace must be a directory")
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
		return fmt.Errorf("open local runtime state: %w", err)
	}
	finalizer := &Daemon{
		cfg: Config{
			DataDir:       dataDir,
			DeviceID:      strings.TrimSpace(options.DeviceID),
			AccessToken:   strings.TrimSpace(options.RelayToken),
			APIBaseURL:    strings.TrimSpace(options.APIBaseURL),
			PollInterval:  5 * time.Second,
			HTTPTimeout:   30 * time.Second,
			DaemonVersion: "local-runtime",
		},
		state:  state,
		client: &http.Client{Timeout: 30 * time.Second},
	}
	// Runtime mode is a mutating workspace path. It must always be able to
	// consult the API's current lease before claiming a local permit; a cached
	// SQLite permit alone is not an authorization source.
	if strings.TrimSpace(finalizer.apiBaseURL()) == "" {
		_ = state.Close()
		return errors.New("local runtime API base URL is required")
	}
	deviceID := strings.TrimSpace(options.DeviceID)
	if deviceID == "" {
		deviceID, _ = LoadCredential(credentialDeviceID)
	}
	if strings.TrimSpace(deviceID) == "" {
		_ = state.Close()
		return errors.New("local runtime device identity is unavailable")
	}
	deviceID = strings.TrimSpace(deviceID)
	options.DeviceID = deviceID
	finalizer.cfg.DeviceID = deviceID
	if _, err := waitForLocalRuntimeReplica(ctx, state, options.SpaceID, options.ReplicaID, deviceID, workspaceDir, localRuntimeReplicaReadyTimeout); err != nil {
		_ = state.Close()
		return err
	}
	defer finalizer.Close()
	refreshCtx, cancelRefresh := context.WithTimeout(ctx, 30*time.Second)
	if err := finalizer.refreshAccessToken(refreshCtx); err == nil {
		if refreshed, credentialErr := finalizer.accessToken(); credentialErr == nil && strings.TrimSpace(refreshed) != "" {
			options.RelayToken = refreshed
		}
	} else {
		options.Logger.Debug("local runtime token refresh skipped", slog.String("error", err.Error()))
	}
	cancelRefresh()
	server := &localRuntimeServer{options: options, finalizer: finalizer, activeAttempts: make(map[string]struct{})}
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
		finalizer.heartbeatLocalRuntimePermits(ctx, server.isAttemptActive)
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
		ReplicaID:     options.ReplicaID,
		Kind:          "runtime",
		RuntimeID:     options.RuntimeID,
		Provider:      options.Provider,
		RuntimeServer: server,
		Logger:        options.Logger,
	})
	options.Logger.Info("local runtime starting",
		slog.String("runtimeId", options.RuntimeID),
		slog.String("spaceId", options.SpaceID),
		slog.String("replicaId", options.ReplicaID),
		slog.String("provider", options.Provider),
		slog.String("workspaceDir", options.WorkspaceDir),
		slog.String("hostCommand", options.ProviderCommand),
	)
	client.Run(ctx)
	// The relay launches each data channel in its own goroutine. Its control
	// loop can return as soon as the parent context is cancelled, while a data
	// channel is still draining provider stdout or persisting terminal evidence.
	// Wait before maintenance and finalizer.Close() release the shared state DB.
	client.WaitDataChannels()
	maintenance.Wait()
	return nil
}

// waitForLocalRuntimeReplica waits for the regular locald sync loop to commit
// the replica snapshot before a runtime can attach a provider process. The API
// readiness check performed by the CLI is server-side; this local check closes
// the interval in which that state is ready remotely but has not reached the
// local SQLite cache yet.
func waitForLocalRuntimeReplica(ctx context.Context, state *StateStore, spaceID, replicaID, deviceID, workspaceRoot string, timeout time.Duration) (*ReplicaState, error) {
	if state == nil {
		return nil, errors.New("local runtime state is unavailable")
	}
	spaceID = strings.TrimSpace(spaceID)
	replicaID = strings.TrimSpace(replicaID)
	deviceID = strings.TrimSpace(deviceID)
	workspaceRoot = filepath.Clean(workspaceRoot)
	if spaceID == "" || replicaID == "" || deviceID == "" || workspaceRoot == "." || workspaceRoot == "" {
		return nil, errors.New("local runtime workspace identity is incomplete")
	}
	if timeout <= 0 {
		timeout = localRuntimeReplicaReadyTimeout
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(localRuntimeReplicaPollInterval)
	defer ticker.Stop()
	var lastStatus string
	for {
		replica, err := state.ReplicaForSpace(spaceID)
		if err != nil {
			return nil, fmt.Errorf("read local runtime workspace binding: %w", err)
		}
		if replica != nil {
			// Identity mismatches are never repaired by waiting. Continuing here
			// could attach a provider to a different folder or device.
			if replica.ReplicaID != replicaID || replica.DeviceID != deviceID || filepath.Clean(replica.Root) != workspaceRoot {
				return nil, errors.New("local runtime workspace does not match the attached local replica")
			}
			lastStatus = strings.TrimSpace(replica.Status)
			switch lastStatus {
			case "conflicted", "detached", "error", "offline":
				return nil, fmt.Errorf("local runtime replica cannot become ready: %s", lastStatus)
			case "ready":
				if strings.TrimSpace(replica.AppliedSnapshotID) != "" {
					return replica, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for local runtime replica readiness: %w", ctx.Err())
		case <-deadline.C:
			if lastStatus == "" {
				lastStatus = "unavailable"
			}
			return nil, fmt.Errorf("local runtime replica did not become ready within %s (status: %s)", timeout, lastStatus)
		case <-ticker.C:
		}
	}
}

// acquireChannel takes the provider channel lock, giving up when the parent
// context ends so a shutdown never blocks behind a stuck channel.
func (s *localRuntimeServer) acquireChannel(ctx context.Context) bool {
	acquired := make(chan struct{})
	go func() {
		s.channelMu.Lock()
		close(acquired)
	}()
	select {
	case <-acquired:
		if ctx.Err() != nil {
			s.channelMu.Unlock()
			return false
		}
		return true
	case <-ctx.Done():
		// Release the lock whenever the goroutine eventually obtains it.
		go func() {
			<-acquired
			s.channelMu.Unlock()
		}()
		return false
	}
}

const defaultRuntimeHostCommand = "cohub-agent-runtime"

// resolveRuntimeHostCommand makes the packaged JavaScript host executable on
// Windows. Unix can execute the npm bin wrapper through its shebang, while
// Windows CreateProcess cannot execute a .js file directly and needs Node as
// the parent process. The CLI passes its exact Node executable path when it
// launches locald; the PATH lookup keeps direct locald users working too.
func resolveRuntimeHostCommand(command string, args []string, targetOS string, nodeExecutable string) (string, []string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", nil, errors.New("local runtime host command is required")
	}
	if targetOS != "windows" {
		return command, append([]string(nil), args...), nil
	}
	extension := strings.ToLower(filepath.Ext(command))
	if extension != ".js" && extension != ".mjs" && extension != ".cjs" {
		return command, append([]string(nil), args...), nil
	}
	nodeExecutable = strings.TrimSpace(nodeExecutable)
	if nodeExecutable == "" {
		resolved, err := exec.LookPath("node")
		if err != nil {
			return "", nil, fmt.Errorf("Node.js is required to run local runtime host %q: %w", command, err)
		}
		nodeExecutable = resolved
	}
	return nodeExecutable, append([]string{command}, args...), nil
}

func normalizeRuntimeProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "pi":
		return "pi"
	case "codex":
		return "codex"
	case "claude", "claude-code", "claude_code":
		return "claude_code"
	default:
		return ""
	}
}

// defaultProviderCommand returns the provider-neutral host executable. Native
// SDK selection happens inside that host, so locald never needs to know how a
// provider is implemented. Keep the provider check here to fail early for a
// malformed runtime registration.
func defaultProviderCommand(provider string) string {
	switch normalizeRuntimeProvider(provider) {
	case "pi", "codex", "claude_code":
		return defaultRuntimeHostCommand
	default:
		return ""
	}
}

// runtimeProcessEnv gives a host enough identity to construct its native SDK
// adapters while preserving the user's provider credentials and shell setup.
// Values are replaced by key rather than appended so inherited environment
// variables cannot override the workspace fence.
func runtimeProcessEnv(options LocalRuntimeOptions) []string {
	env := os.Environ()
	values := map[string]string{
		// These names are consumed by the standalone host package.
		"COHUB_RUNTIME_ID":       options.RuntimeID,
		"COHUB_SPACE_ID":         options.SpaceID,
		"COHUB_RUNTIME_PROVIDER": options.Provider,
		"COHUB_RUNTIME_CWD":      options.WorkspaceDir,
	}
	if options.ConnectionEpoch > 0 {
		values["COHUB_RUNTIME_CONNECTION_EPOCH"] = fmt.Sprintf("%d", options.ConnectionEpoch)
	}
	if strings.TrimSpace(options.ExecutionAttemptID) != "" {
		values["COHUB_RUNTIME_EXECUTION_ATTEMPT_ID"] = strings.TrimSpace(options.ExecutionAttemptID)
	}
	// A remote prompt can ask the native provider to run a local command. Never
	// expose Cohub bearer credentials to that command (or to a provider child
	// process), even when the runtime was started from an authenticated CLI.
	blockedCredentialKeys := map[string]struct{}{
		"COHUB_ACCESS_TOKEN":              {},
		"COHUB_EXECUTION_TOKEN":           {},
		"COHUB_LOCAL_AGENT_ACCESS_TOKEN":  {},
		"COHUB_LOCAL_AGENT_REFRESH_TOKEN": {},
		"COHUB_RELAY_TOKEN":               {},
		"COHUB_RUNTIME_TOKEN":             {},
		"COHUB_TOKEN":                     {},
	}
	// Remove all runtime-owned and credential keys in one pass. Filtering into env[:0] while
	// ranging over env can overwrite entries that have not been visited yet,
	// silently dropping provider credentials from the child process.
	keys := []string{
		"COHUB_RUNTIME_ID",
		"COHUB_SPACE_ID",
		"COHUB_RUNTIME_PROVIDER",
		"COHUB_RUNTIME_CWD",
		"COHUB_RUNTIME_CONNECTION_EPOCH",
		"COHUB_RUNTIME_EXECUTION_ATTEMPT_ID",
	}
	filtered := make([]string, 0, len(env)+len(keys))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		if _, blocked := blockedCredentialKeys[key]; blocked {
			continue
		}
		owned := false
		for _, key := range keys {
			if strings.HasPrefix(item, key+"=") {
				owned = true
				break
			}
		}
		if !owned {
			filtered = append(filtered, item)
		}
	}
	for _, key := range keys {
		if value, ok := values[key]; ok {
			filtered = append(filtered, key+"="+value)
		}
	}
	return filtered
}

// channelBinding is the workspace binding the gateway forwards in the `open`
// frame for one local runtime channel. It is validated against the runtime's own
// registration before the provider starts, and the execution permit it names
// is claimed exactly once.
type channelBinding struct {
	ExecutionAttemptID string `json:"executionAttemptId"`
	SpaceID            string `json:"spaceId"`
	ReplicaID          string `json:"replicaId"`
	ConnectionEpoch    int64  `json:"connectionEpoch"`
	BaseSnapshotID     string `json:"baseSnapshotId"`
	LeaseEpoch         int64  `json:"leaseEpoch"`
	LeaseExpiresAt     string `json:"leaseExpiresAt"`
}

type runtimeAttemptRef struct {
	attemptID       string
	spaceID         string
	replicaID       string
	runtimeID       string
	connectionEpoch int64
	baseSnapshotID  string
	leaseEpoch      int64
	expiresAt       time.Time
}

func parseChannelBinding(raw json.RawMessage, runtimeSpaceID, runtimeReplicaID, runtimeID string) (runtimeAttemptRef, error) {
	if len(bytesTrimSpace(raw)) == 0 {
		return runtimeAttemptRef{}, errors.New("channel binding is missing")
	}
	runtimeID = strings.TrimSpace(runtimeID)
	if runtimeID == "" {
		return runtimeAttemptRef{}, errors.New("registered runtime identity is missing")
	}
	var binding channelBinding
	if err := json.Unmarshal(raw, &binding); err != nil {
		return runtimeAttemptRef{}, fmt.Errorf("channel binding is invalid: %w", err)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(binding.LeaseExpiresAt))
	if err != nil || !expiresAt.After(time.Now().UTC()) {
		return runtimeAttemptRef{}, errors.New("channel binding lease has expired or has an invalid expiry")
	}
	if binding.LeaseEpoch < 1 {
		return runtimeAttemptRef{}, errors.New("channel binding lease epoch is invalid")
	}
	if binding.ConnectionEpoch < 1 {
		return runtimeAttemptRef{}, errors.New("channel binding connection epoch is invalid")
	}
	for _, value := range []struct{ name, id string }{
		{"executionAttemptId", binding.ExecutionAttemptID},
		{"spaceId", binding.SpaceID},
		{"replicaId", binding.ReplicaID},
		{"baseSnapshotId", binding.BaseSnapshotID},
	} {
		if _, err := uuid.Parse(strings.TrimSpace(value.id)); err != nil {
			return runtimeAttemptRef{}, fmt.Errorf("channel binding %s is not a UUID", value.name)
		}
	}
	if runtimeSpaceID != "" && binding.SpaceID != runtimeSpaceID {
		return runtimeAttemptRef{}, errors.New("channel binding Space does not match the registered runtime")
	}
	if runtimeReplicaID != "" && binding.ReplicaID != runtimeReplicaID {
		return runtimeAttemptRef{}, errors.New("channel binding replica does not match the registered runtime")
	}
	return runtimeAttemptRef{
		attemptID:       strings.TrimSpace(binding.ExecutionAttemptID),
		spaceID:         strings.TrimSpace(binding.SpaceID),
		replicaID:       strings.TrimSpace(binding.ReplicaID),
		runtimeID:       runtimeID,
		connectionEpoch: binding.ConnectionEpoch,
		baseSnapshotID:  strings.TrimSpace(binding.BaseSnapshotID),
		leaseEpoch:      binding.LeaseEpoch,
		expiresAt:       expiresAt,
	}, nil
}

// ServeChannel runs one host process for one relay data channel and pipes
// bytes between them without interpreting local runtime. The Cohub Agent on the other
// end speaks local runtime through the official SDK; locald's job here is only to fence
// the workspace (claim the permit named by the binding) and to record a
// durable terminal marker when the channel ends so the replica finalizes.
func (s *localRuntimeServer) ServeChannel(parent context.Context, conn *websocket.Conn, remote string, binding json.RawMessage) {
	// Apply the limit before any read or provider process is started. This is a
	// resource fence in addition to the line-level limit in pipeRelayToProvider.
	conn.SetReadLimit(localRuntimeMessageLimit)
	ref, err := parseChannelBinding(binding, s.options.SpaceID, s.options.ReplicaID, s.options.RuntimeID)
	if err != nil {
		s.options.Logger.Warn("local runtime channel rejected", slog.String("remote", remote), slog.String("error", err.Error()))
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	if !s.acquireChannel(parent) {
		_ = conn.Close(websocket.StatusTryAgainLater, "runtime already has an active provider channel")
		return
	}
	defer s.channelMu.Unlock()
	// The background sync loop is intentionally low-frequency. Refresh the
	// server-authoritative lease immediately before claiming the one-shot local
	// permit so a newly queued turn cannot race the polling interval.
	refreshCtx, cancelRefresh := context.WithTimeout(parent, 10*time.Second)
	if s.finalizer == nil {
		cancelRefresh()
		_ = conn.Close(websocket.StatusPolicyViolation, "local runtime finalizer is unavailable")
		return
	}
	// A local prepared permit is only a cache of server authority. Never start
	// a provider from it when the API endpoint is unavailable: doing so could
	// mutate a workspace after the cloud lease was revoked or reassigned.
	if strings.TrimSpace(s.finalizer.apiBaseURL()) == "" {
		cancelRefresh()
		s.options.Logger.Warn("local runtime authoritative permit refresh unavailable", slog.String("attemptId", ref.attemptID))
		_ = conn.Close(websocket.StatusPolicyViolation, "local runtime API endpoint is unavailable")
		return
	}
	if err := s.finalizer.refreshLocalRuntimePermit(refreshCtx, ref); err != nil {
		cancelRefresh()
		s.options.Logger.Warn("authoritative local runtime permit refresh failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
		_ = conn.Close(websocket.StatusPolicyViolation, "local runtime workspace lease is not authorized")
		return
	}
	cancelRefresh()
	if err := s.startAttempt(ref); err != nil {
		// A claim failure is deliberately not treated as a provider start
		// failure: another locald process may already own the permit and still
		// have a provider mutating the workspace. Keep the existing fence and
		// let the authoritative recovery path decide whether it is stale.
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	providerStarted := false
	startupFailure := ""
	var terminalEvidence atomic.Bool
	defer func() {
		if !providerStarted {
			// No provider process ever received a command, so the claimed permit
			// is safe to retire. The server-side attempt/lease cleanup is queued
			// durably and retried by the runtime's replay loop.
			s.finishAttempt(ref, false)
			s.finishProviderStartFailure(ref, startupFailure)
			return
		}
		s.finishAttempt(ref, terminalEvidence.Load())
	}()

	ctx, cancel := context.WithCancel(parent)
	var leaseHeartbeat *localRuntimeLeaseHeartbeat
	var leaseWatch sync.WaitGroup
	defer func() {
		// Cancel both the provider and the lease heartbeat before waiting for
		// the watcher. The heartbeat request uses this context, so shutdown
		// cannot leave an in-flight network call behind the channel teardown.
		cancel()
		leaseWatch.Wait()
		if leaseHeartbeat != nil {
			leaseHeartbeat.stop()
		}
	}()
	permit, permitErr := s.finalizer.state.PermitContext(ref.attemptID)
	if permitErr != nil {
		startupFailure = fmt.Sprintf("local runtime permit could not be read: %s", permitErr.Error())
		return
	}
	leaseHeartbeat, permitErr = s.startAttemptLeaseHeartbeat(ctx, ref, permit)
	if permitErr != nil {
		startupFailure = fmt.Sprintf("local runtime workspace lease heartbeat could not start: %s", permitErr.Error())
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "runtime session closed")
	// Watch the lease before spawning the provider as well as while it is
	// running. Native SDK initialization can perform filesystem and credential
	// work before the child emits its first frame; losing the writer lease in
	// that window must still prevent the child from starting with stale access.
	leaseWatch.Add(1)
	go func() {
		defer leaseWatch.Done()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if heartbeatErr := leaseHeartbeat.check(); heartbeatErr != nil {
					s.options.Logger.Warn("local runtime workspace lease heartbeat failed", slog.String("attemptId", ref.attemptID), slog.String("error", heartbeatErr.Error()))
					cancel()
					return
				}
			}
		}
	}()

	command := strings.TrimSpace(s.options.ProviderCommand)
	cmd := exec.CommandContext(ctx, command, s.options.ProviderArgs...)
	cmd.Dir = s.options.WorkspaceDir
	// The provider is the user's own agent. It inherits the shell environment
	// unchanged; protecting local secrets is the user's responsibility, as it is
	// when they run the provider directly.
	processOptions := s.options
	processOptions.ConnectionEpoch = ref.connectionEpoch
	processOptions.ExecutionAttemptID = ref.attemptID
	cmd.Env = runtimeProcessEnv(processOptions)
	configureProviderProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		startupFailure = fmt.Sprintf("local runtime host stdin unavailable: %s", err.Error())
		s.options.Logger.Warn("local runtime host stdin unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		startupFailure = fmt.Sprintf("local runtime host stdout unavailable: %s", err.Error())
		_ = stdin.Close()
		s.options.Logger.Warn("local runtime host stdout unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		startupFailure = fmt.Sprintf("local runtime host stderr unavailable: %s", err.Error())
		_ = stdin.Close()
		_ = stdout.Close()
		s.options.Logger.Warn("local runtime host stderr unavailable", slog.String("remote", remote), slog.String("error", err.Error()))
		return
	}
	if heartbeatErr := leaseHeartbeat.check(); heartbeatErr != nil {
		startupFailure = fmt.Sprintf("local runtime workspace lease heartbeat failed before provider start: %s", heartbeatErr.Error())
		return
	}
	if err := ctx.Err(); err != nil {
		startupFailure = fmt.Sprintf("local runtime provider start cancelled: %s", err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		startupFailure = fmt.Sprintf("local runtime host failed to start: %s", err.Error())
		s.options.Logger.Warn("local runtime host failed to start", slog.String("command", command), slog.String("error", err.Error()))
		return
	}
	providerStarted = true
	s.options.Logger.Info("local runtime host started", slog.String("remote", remote), slog.String("command", command), slog.Int("pid", cmd.Process.Pid), slog.String("attemptId", ref.attemptID))

	var once sync.Once
	processWaitDone := make(chan struct{})
	var processWaitMu sync.Mutex
	var processWaitErr error
	// Reap the host independently of the channel workers. In particular, the
	// close acknowledgement can ask us to terminate the host while the relay
	// socket must remain open long enough to carry the post-reap acknowledgement.
	go func() {
		err := cmd.Wait()
		processWaitMu.Lock()
		processWaitErr = err
		processWaitMu.Unlock()
		close(processWaitDone)
	}()
	closeProvider := func() {
		once.Do(func() {
			_ = stdin.Close()
			if cmd.Process == nil {
				return
			}
			_ = terminateProviderProcess(cmd)
			go func() {
				timer := time.NewTimer(2 * time.Second)
				defer timer.Stop()
				select {
				case <-processWaitDone:
				case <-timer.C:
					_ = forceKillProviderProcess(cmd)
				}
			}()
		})
	}
	var awaitingHostReap atomic.Bool
	var closeAckOnce sync.Once
	var closeCommandMu sync.RWMutex
	var closeCommandID string
	// The runner's session.close event proves that the provider SDK released
	// its session, but the host process may still hold workspace file handles.
	// Keep the channel alive until cmd.Wait has completed, then publish a fresh
	// event so the Agent can release the cloud lease only after this fence.
	announceHostReaped := func(line []byte) {
		closeAckOnce.Do(func() {
			awaitingHostReap.Store(true)
			closeProvider()
			go func(original []byte) {
				<-processWaitDone
				reaped, marshalErr := hostReapedRuntimeEvent(original)
				if marshalErr == nil {
					writeCtx, cancelWrite := context.WithTimeout(context.Background(), 5*time.Second)
					framed := append(append([]byte(nil), reaped...), '\n')
					if writeErr := conn.Write(writeCtx, websocket.MessageText, framed); writeErr != nil {
						s.options.Logger.Debug("local runtime host reap acknowledgement could not be sent", slog.String("remote", remote), slog.String("error", writeErr.Error()))
					}
					cancelWrite()
				} else {
					s.options.Logger.Warn("local runtime host reap acknowledgement could not be constructed", slog.String("remote", remote), slog.String("error", marshalErr.Error()))
				}
				awaitingHostReap.Store(false)
				cancel()
			}(append([]byte(nil), line...))
		})
	}

	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		if err := pipeProviderToRelay(ctx, conn, stdout, func(line []byte) {
			if isRuntimeTerminalEventForAttempt(line, s.options.RuntimeID, ref) {
				terminalEvidence.Store(true)
			}
			closeCommandMu.RLock()
			expectedCloseCommandID := closeCommandID
			closeCommandMu.RUnlock()
			if isRuntimeSessionCloseAckForAttempt(line, s.options.RuntimeID, ref, expectedCloseCommandID) {
				announceHostReaped(line)
			}
		}); err != nil && !errors.Is(err, context.Canceled) {
			s.options.Logger.Debug("local runtime host output ended", slog.String("remote", remote), slog.String("error", err.Error()))
		}
		if !awaitingHostReap.Load() {
			cancel()
		}
	}()
	go func() {
		defer workers.Done()
		if err := pipeRelayToProvider(ctx, conn, stdin, ref, func(line []byte) {
			if commandID, ok := runtimeSessionCloseCommandID(line, s.options.RuntimeID, ref); ok {
				closeCommandMu.Lock()
				if closeCommandID == "" {
					closeCommandID = commandID
				}
				closeCommandMu.Unlock()
			}
		}); err != nil && !errors.Is(err, context.Canceled) {
			s.options.Logger.Debug("local runtime host input ended", slog.String("remote", remote), slog.String("error", err.Error()))
		}
		if !awaitingHostReap.Load() {
			cancel()
		}
	}()
	go func() {
		defer workers.Done()
		// stderr is diagnostic output; its pipe may close independently of the
		// local runtime transport and must not terminate a live provider session.
		copyRuntimeStderr(s.options.Logger, stderr, remote)
	}()

	<-ctx.Done()
	closeProvider()
	// Do not close the relay channel until the host process has been reaped.
	// The Agent uses the channel close as the final transport fence before it
	// releases the cloud workspace lease; closing it earlier would let a new
	// execution claim the replica while the native provider still has the
	// workspace open.
	workers.Wait()
	<-processWaitDone
	processWaitMu.Lock()
	waitErr := processWaitErr
	processWaitMu.Unlock()
	if waitErr != nil && ctx.Err() == nil {
		s.options.Logger.Debug("local runtime host exited with error", slog.String("remote", remote), slog.String("error", waitErr.Error()))
	}
	_ = conn.Close(websocket.StatusNormalClosure, "runtime session ended")
}

// pipeProviderToRelay forwards newline-delimited host output as one
// WebSocket text frame per line. Keep the LF delimiter in the frame: the Agent
// transport treats the relay as an LF-delimited stream, while JSON parsers
// still accept the trailing whitespace for callers that inspect one frame at a
// time.
func pipeProviderToRelay(ctx context.Context, conn *websocket.Conn, output io.Reader, observers ...func([]byte)) error {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytesTrimSpace(line)) == 0 {
			continue
		}
		for _, observe := range observers {
			if observe != nil {
				observe(line)
			}
		}
		framed := make([]byte, len(line)+1)
		copy(framed, line)
		framed[len(line)] = '\n'
		if err := conn.Write(ctx, websocket.MessageText, framed); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// isRuntimeTerminalEvent recognizes only the normalized envelope fields needed
// to decide whether a workspace finalization spool record is justified. The
// Agent remains authoritative for event validation and transcript persistence.
func isRuntimeTerminalEvent(line []byte) bool {
	envelope, ok := decodeRuntimeEventIdentity(line)
	if !ok || envelope.Type != "event" {
		return false
	}
	return envelope.Kind == "turn.completed" || envelope.Kind == "turn.failed"
}

type runtimeEventIdentity struct {
	Type               string `json:"type"`
	RuntimeID          string `json:"runtimeId"`
	ExecutionAttemptID string `json:"executionAttemptId"`
	ConnectionEpoch    int64  `json:"connectionEpoch"`
	Kind               string `json:"kind"`
}

func decodeRuntimeEventIdentity(line []byte) (runtimeEventIdentity, bool) {
	var envelope runtimeEventIdentity
	if err := json.Unmarshal(line, &envelope); err != nil {
		return runtimeEventIdentity{}, false
	}
	return envelope, true
}

// isRuntimeTerminalEventForAttempt accepts terminal evidence only when the
// normalized event is bound to the channel that produced it. The Agent still
// performs full schema and transcript validation; locald independently fences
// the finalization trigger against forged or stale provider output.
func isRuntimeTerminalEventForAttempt(line []byte, runtimeID string, ref runtimeAttemptRef) bool {
	envelope, ok := decodeRuntimeEventIdentity(line)
	if !ok || envelope.Type != "event" {
		return false
	}
	if envelope.Kind != "turn.completed" && envelope.Kind != "turn.failed" {
		return false
	}
	return strings.TrimSpace(runtimeID) != "" && envelope.RuntimeID == runtimeID && envelope.ExecutionAttemptID == ref.attemptID && envelope.ConnectionEpoch == ref.connectionEpoch
}

// isRuntimeSessionCloseAckForAttempt identifies the runner acknowledgement
// that the native provider handle has closed. It intentionally does not treat
// arbitrary session.ready events as a shutdown request; only the close
// operation for this channel may trigger host reaping.
func isRuntimeSessionCloseAckForAttempt(line []byte, runtimeID string, ref runtimeAttemptRef, expectedCommandID string) bool {
	var envelope struct {
		Type               string `json:"type"`
		RuntimeID          string `json:"runtimeId"`
		ExecutionAttemptID string `json:"executionAttemptId"`
		ConnectionEpoch    int64  `json:"connectionEpoch"`
		Kind               string `json:"kind"`
		Payload            struct {
			CommandID string `json:"commandId"`
			Operation string `json:"operation"`
			Status    string `json:"status"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return false
	}
	return envelope.Type == "event" &&
		envelope.Kind == "session.ready" &&
		envelope.RuntimeID == runtimeID &&
		envelope.ExecutionAttemptID == ref.attemptID &&
		envelope.ConnectionEpoch == ref.connectionEpoch &&
		strings.TrimSpace(expectedCommandID) != "" &&
		envelope.Payload.CommandID == expectedCommandID &&
		envelope.Payload.Operation == "session.close" &&
		envelope.Payload.Status == "closed"
}

func runtimeSessionCloseCommandID(line []byte, runtimeID string, ref runtimeAttemptRef) (string, bool) {
	var command struct {
		Type               string `json:"type"`
		RuntimeID          string `json:"runtimeId"`
		ExecutionAttemptID string `json:"executionAttemptId"`
		ConnectionEpoch    int64  `json:"connectionEpoch"`
		CommandID          string `json:"commandId"`
		Operation          string `json:"operation"`
	}
	if err := json.Unmarshal(line, &command); err != nil {
		return "", false
	}
	if command.Type != "command" || command.RuntimeID != runtimeID || command.ExecutionAttemptID != ref.attemptID || command.ConnectionEpoch != ref.connectionEpoch || command.Operation != "session.close" || strings.TrimSpace(command.CommandID) == "" {
		return "", false
	}
	return command.CommandID, true
}

// hostReapedRuntimeEvent creates a new event identity rather than mutating
// the provider event in place. This keeps the original close receipt durable
// while giving the Agent an unambiguous post-process-reap barrier.
func hostReapedRuntimeEvent(line []byte) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil {
		return nil, err
	}
	var payload map[string]any
	if raw := fields["payload"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
	}
	if payload == nil {
		return nil, errors.New("runtime close acknowledgement payload is missing")
	}
	payload["hostReaped"] = true
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	fields["payload"] = encodedPayload
	// A providerEventId may be present on the original event. Remove it so the
	// Agent's receipt key is based on this synthetic event's fresh eventId.
	delete(fields, "providerEventId")
	encodedID, err := json.Marshal(uuid.NewString())
	if err != nil {
		return nil, err
	}
	fields["eventId"] = encodedID
	var sequence int64
	if raw := fields["sequence"]; len(raw) > 0 && json.Unmarshal(raw, &sequence) == nil && sequence > 0 && sequence < int64(^uint64(0)>>1) {
		sequence++
	} else {
		sequence = 1
	}
	encodedSequence, err := json.Marshal(sequence)
	if err != nil {
		return nil, err
	}
	fields["sequence"] = encodedSequence
	emittedAt, err := json.Marshal(time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	fields["emittedAt"] = emittedAt
	return json.Marshal(fields)
}

type runtimeCommandIdentity struct {
	Type               string  `json:"type"`
	RuntimeID          string  `json:"runtimeId"`
	SpaceID            string  `json:"spaceId"`
	ExecutionAttemptID *string `json:"executionAttemptId"`
	ConnectionEpoch    int64   `json:"connectionEpoch"`
}

// validateRuntimeCommandForChannel checks the identity fields before a frame
// reaches the provider host. The cloud Agent validates the complete command
// schema, but locald must independently prevent a valid channel from being
// reused to mutate the workspace for another execution attempt.
func validateRuntimeCommandForChannel(line []byte, ref runtimeAttemptRef) error {
	var command runtimeCommandIdentity
	if err := json.Unmarshal(bytesTrimSpace(line), &command); err != nil {
		return fmt.Errorf("runtime command is invalid JSON: %w", err)
	}
	if command.Type != "command" {
		return errors.New("runtime channel accepts command frames only")
	}
	if strings.TrimSpace(ref.runtimeID) == "" || command.RuntimeID != ref.runtimeID {
		return errors.New("runtime command runtimeId does not match the channel")
	}
	if command.SpaceID != ref.spaceID {
		return errors.New("runtime command spaceId does not match the channel")
	}
	if command.ExecutionAttemptID == nil || strings.TrimSpace(*command.ExecutionAttemptID) != ref.attemptID {
		return errors.New("runtime command executionAttemptId does not match the channel")
	}
	if command.ConnectionEpoch != ref.connectionEpoch {
		return errors.New("runtime command connectionEpoch does not match the channel")
	}
	return nil
}

// pipeRelayToProvider forwards each WebSocket frame from the Agent as one
// newline-terminated line on the provider's stdin. Identity is checked before
// forwarding so the provider never observes a command outside its lease.
func pipeRelayToProvider(ctx context.Context, conn *websocket.Conn, input io.Writer, ref runtimeAttemptRef, observers ...func([]byte)) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		trimmed := bytesTrimSpace(data)
		if len(trimmed) == 0 {
			continue
		}
		if err := validateRuntimeCommandForChannel(trimmed, ref); err != nil {
			return err
		}
		for _, observe := range observers {
			if observe != nil {
				observe(trimmed)
			}
		}
		if _, err := input.Write(append(append([]byte(nil), trimmed...), '\n')); err != nil {
			return err
		}
	}
}

func (s *localRuntimeServer) startAttempt(ref runtimeAttemptRef) error {
	if s.finalizer == nil || ref.attemptID == "" || ref.spaceID == "" || ref.replicaID == "" || ref.leaseEpoch < 1 {
		return errors.New("local runtime channel has incomplete workspace lease provenance")
	}
	if !ref.expiresAt.After(time.Now().UTC()) {
		return errors.New("local runtime channel workspace lease has expired")
	}
	if err := s.finalizer.state.ClaimLocalRuntimePermit(ref.attemptID, ref.spaceID, ref.replicaID, ref.runtimeID, ref.baseSnapshotID, ref.leaseEpoch, ref.expiresAt); err != nil {
		s.options.Logger.Warn("claim local runtime permit failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
		return fmt.Errorf("claim local runtime permit: %w", err)
	}
	s.attemptMu.Lock()
	if s.activeAttempts == nil {
		s.activeAttempts = make(map[string]struct{})
	}
	s.activeAttempts[ref.attemptID] = struct{}{}
	s.attemptMu.Unlock()
	return nil
}

// startAttemptLeaseHeartbeat validates the permit claimed by this channel
// before renewing its server lease. The local permit is a durable handoff
// record, so a heartbeat must never be sent for a permit belonging to another
// runtime, replica, or lease epoch.
func (s *localRuntimeServer) startAttemptLeaseHeartbeat(ctx context.Context, ref runtimeAttemptRef, permit *PermitContext) (*localRuntimeLeaseHeartbeat, error) {
	if s.finalizer == nil || s.finalizer.state == nil {
		return nil, errors.New("local runtime finalizer is unavailable")
	}
	if permit == nil {
		return nil, errors.New("local runtime execution permit is unavailable")
	}
	if permit.ExecutionAttemptID != ref.attemptID || permit.SpaceID != ref.spaceID || permit.ReplicaID != ref.replicaID || permit.RuntimeID != ref.runtimeID || permit.BaseSnapshotID != ref.baseSnapshotID || permit.LeaseEpoch != ref.leaseEpoch {
		return nil, errors.New("local runtime execution permit does not match the channel binding")
	}
	if permit.Status != "active" || permit.HolderKind != "local_agent" || permit.HolderID != localRuntimePermitHolderID(ref.attemptID) {
		return nil, errors.New("local runtime execution permit is not claimed by this channel")
	}
	if !permit.ExpiresAt.After(time.Now().UTC()) {
		return nil, errors.New("local runtime execution permit has expired")
	}
	return s.finalizer.startLocalRuntimeLeaseHeartbeat(ctx, ref.spaceID, permit)
}

func (s *localRuntimeServer) isAttemptActive(attemptID string) bool {
	s.attemptMu.Lock()
	defer s.attemptMu.Unlock()
	_, ok := s.activeAttempts[attemptID]
	return ok
}

func (s *localRuntimeServer) finishAttempt(ref runtimeAttemptRef, terminalEvidence bool) {
	s.attemptMu.Lock()
	delete(s.activeAttempts, ref.attemptID)
	s.attemptMu.Unlock()
	if !terminalEvidence {
		return
	}
	if s.finalizer == nil || ref.attemptID == "" || ref.spaceID == "" || ref.replicaID == "" {
		return
	}
	// Persist terminal evidence before any network call. The regular daemon or
	// this runtime's replay loop performs the idempotent workspace finalization.
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
		s.options.Logger.Error("queue local runtime workspace finalization failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
	}
}

func (s *localRuntimeServer) finishProviderStartFailure(ref runtimeAttemptRef, reason string) {
	if s.finalizer == nil || ref.attemptID == "" || ref.spaceID == "" || ref.replicaID == "" || ref.runtimeID == "" || ref.leaseEpoch < 1 {
		return
	}
	message := strings.TrimSpace(reason)
	if message == "" {
		message = "local runtime provider failed to start"
	}
	eventID := "runtime-start-failed:" + ref.attemptID
	payload := mustJSON(spoolEnvelope{
		Kind:               "runtime_start_failed",
		Version:            protocolVersion,
		EventID:            eventID,
		SpaceID:            ref.spaceID,
		ReplicaID:          ref.replicaID,
		ExecutionAttemptID: ref.attemptID,
		RuntimeID:          ref.runtimeID,
		LeaseEpoch:         ref.leaseEpoch,
		ErrorMessage:       message,
	})
	if _, err := s.finalizer.state.AppendSpool(eventID, payload); err != nil {
		s.options.Logger.Error("queue local runtime start failure cleanup failed", slog.String("attemptId", ref.attemptID), slog.String("error", err.Error()))
		return
	}
	// A start-failure cleanup is only safe to send immediately when this local
	// state store still contains the permit claimed for the channel. If the
	// permit is absent, keep the durable record for the normal replay path
	// rather than issuing a mutation with incomplete local provenance.
	permit, permitErr := s.finalizer.state.PermitContext(ref.attemptID)
	if permitErr != nil || permit == nil {
		return
	}
	// Try once before returning so the Agent observes a terminal attempt quickly;
	// the durable spool remains for replay when the API is unavailable.
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.finalizer.replayOnce(cleanupCtx)
}

func copyRuntimeStderr(logger *slog.Logger, input io.Reader, remote string) {
	// Keep a buffered reader underneath Scanner so a line that exceeds the
	// diagnostic limit can still be drained. Stopping Scanner at ErrTooLong
	// leaves the child blocked once the OS pipe fills, preventing ServeChannel
	// from ever observing cancellation or process exit.
	reader := bufio.NewReader(input)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 8*1024), 512*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			logger.Debug("local runtime host stderr", slog.String("remote", remote), slog.String("line", line))
		}
	}
	if scanner.Err() != nil {
		// Scanner may have already consumed part of the oversized token. The
		// buffered reader retains any remaining bytes; drain both it and the
		// underlying pipe until the provider exits or the channel is cancelled.
		_, _ = io.Copy(io.Discard, reader)
	}
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
