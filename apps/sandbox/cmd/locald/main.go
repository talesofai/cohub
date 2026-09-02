package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/cohub/apps/sandbox/locald"
)

var buildVersion = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "--version", "version":
		fmt.Println(buildVersion)
	case "daemon":
		if err := runDaemon(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "hook":
		if err := runHook(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			// Hook callers should receive a clear non-zero result only when the
			// event could not be durably spooled at all.
			os.Exit(1)
		}
	case "configure":
		if err := runConfigure(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "collect-pi":
		if err := runCollectPI(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "credentials":
		if err := runCredentials(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "credentials-status":
		if err := runCredentialsStatus(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "fingerprint":
		if err := runFingerprint(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "permit":
		if err := runPermit(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "runtime":
		if err := runRuntime(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "preflight", "status", "flush", "refresh":
		if err := runSimpleIPC(os.Args[1], os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func runDaemon(args []string) error {
	flags := flag.NewFlagSet("daemon", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	apiURL := flags.String("api", "", "Cohub API base URL")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	if *apiURL != "" {
		cfg.APIBaseURL = *apiURL
	}
	daemon, err := locald.NewDaemon(cfg)
	if err != nil {
		return err
	}
	defer daemon.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return daemon.Run(ctx)
}

func runHook(args []string) error {
	flags := flag.NewFlagSet("hook", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	provider := flags.String("provider", "", "provider name")
	providerVersion := flags.String("provider-version", "unknown", "provider version")
	event := flags.String("event", "", "provider event name")
	cwd := flags.String("cwd", "", "provider current working directory")
	attempt := flags.String("execution-attempt-id", "", "execution attempt id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*provider) == "" || strings.TrimSpace(*event) == "" {
		return errors.New("--provider and --event are required")
	}
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, 512*1024))
	if err != nil {
		return fmt.Errorf("read hook input: %w", err)
	}
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	resolvedCWD := strings.TrimSpace(*cwd)
	var hookInput map[string]any
	if json.Unmarshal(payload, &hookInput) == nil && resolvedCWD == "" {
		if value, ok := hookInput["cwd"].(string); ok {
			resolvedCWD = strings.TrimSpace(value)
		}
	}
	if resolvedCWD == "" {
		resolvedCWD, _ = os.Getwd()
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	executionAttemptID := strings.TrimSpace(*attempt)
	if isPromptSubmitEvent(*event) && executionAttemptID == "" {
		preflightCtx, cancelPreflight := context.WithTimeout(context.Background(), 100*time.Millisecond)
		response, preflightErr := locald.SendRequest(preflightCtx, cfg, locald.IPCRequest{
			Version: 1,
			Type:    "preflight",
			CWD:     resolvedCWD,
		})
		cancelPreflight()
		if preflightErr != nil || !response.OK {
			reason := response.Message
			if reason == "" && preflightErr != nil {
				reason = preflightErr.Error()
			}
			if reason == "" {
				reason = "Workspace handoff is not ready."
			}
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"decision": "block", "reason": reason})
		}
		executionAttemptID = response.ExecutionAttemptID
	}
	hookCtx, cancelHook := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelHook()
	_, sendErr := locald.SendHook(hookCtx, cfg, locald.IPCRequest{
		Version:            1,
		Provider:           strings.TrimSpace(*provider),
		ProviderVersion:    strings.TrimSpace(*providerVersion),
		Event:              strings.TrimSpace(*event),
		CWD:                resolvedCWD,
		ExecutionAttemptID: executionAttemptID,
		Payload:            json.RawMessage(payload),
	})
	return sendErr
}

func isPromptSubmitEvent(event string) bool {
	normalized := strings.ToLower(strings.TrimSpace(event))
	return strings.Contains(normalized, "userpromptsubmit") || strings.Contains(normalized, "user_prompt_submit") || normalized == "input" || normalized == "prompt_submitted"
}

func runConfigure(args []string) error {
	flags := flag.NewFlagSet("configure", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	spaceID := flags.String("space-id", "", "Space id")
	replicaID := flags.String("replica-id", "", "replica id")
	deviceID := flags.String("device-id", "", "device id")
	root := flags.String("root", "", "workspace root")
	fingerprint := flags.String("root-fingerprint", "", "root fingerprint")
	policyVersion := flags.Int64("policy-version", 1, "workspace policy version")
	integrationVersion := flags.Int64("integration-policy-version", 1, "integration policy version")
	mirrorMode := flags.String("session-mirror-mode", "disabled", "session mirror mode")
	initialChoice := flags.String("initial-choice", "", "initial reconciliation choice")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	response, err := locald.SendRequest(context.Background(), cfg, locald.IPCRequest{
		Version:            1,
		Type:               "configure_replica",
		SpaceID:            *spaceID,
		ReplicaID:          *replicaID,
		Device:             *deviceID,
		Root:               *root,
		RootFingerprint:    *fingerprint,
		PolicyVersion:      *policyVersion,
		IntegrationVersion: *integrationVersion,
		MirrorMode:         *mirrorMode,
		InitialChoice:      *initialChoice,
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}

func runCollectPI(args []string) error {
	flags := flag.NewFlagSet("collect-pi", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	cwd := flags.String("cwd", "", "provider current working directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	resolvedCWD := strings.TrimSpace(*cwd)
	if resolvedCWD == "" {
		resolvedCWD, _ = os.Getwd()
	}
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024*1024))
	if err != nil {
		return err
	}
	if len(payload) == 0 {
		return errors.New("Pi collector input is required")
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	response, err := locald.SendRequest(context.Background(), cfg, locald.IPCRequest{
		Version: 1,
		Type:    "collect_pi",
		CWD:     resolvedCWD,
		Payload: json.RawMessage(payload),
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}

func runCredentials(args []string) error {
	flags := flag.NewFlagSet("credentials", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	var input struct {
		DeviceID     string `json:"deviceId"`
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		APIBaseURL   string `json:"apiBaseUrl"`
	}
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 64*1024)).Decode(&input); err != nil {
		return fmt.Errorf("read credentials: %w", err)
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" || strings.TrimSpace(input.RefreshToken) == "" {
		return errors.New("deviceId and refreshToken are required")
	}
	previousDeviceID, previousErr := locald.LoadCredential("device-id")
	if previousErr != nil && !errors.Is(previousErr, locald.ErrCredentialNotFound) {
		return previousErr
	}
	if strings.TrimSpace(previousDeviceID) != deviceID {
		if _, err := locald.RotateIdentity(); err != nil {
			return fmt.Errorf("rotate device identity: %w", err)
		}
	}
	if err := locald.SaveCredential("device-id", deviceID); err != nil {
		return err
	}
	if err := locald.SaveCredential("refresh-token", input.RefreshToken); err != nil {
		return err
	}
	if strings.TrimSpace(input.AccessToken) != "" {
		if err := locald.SaveCredential("access-token", input.AccessToken); err != nil {
			return err
		}
	}
	if strings.TrimSpace(input.APIBaseURL) != "" {
		resolvedDataDir := strings.TrimSpace(*dataDir)
		if resolvedDataDir == "" {
			resolvedDataDir = locald.DefaultDataDir()
		}
		store, err := locald.OpenState(resolvedDataDir)
		if err != nil {
			return err
		}
		defer store.Close()
		if err := store.PutMeta("api_base_url", strings.TrimRight(strings.TrimSpace(input.APIBaseURL), "/")); err != nil {
			return err
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "deviceId": input.DeviceID})
}

func runCredentialsStatus(args []string) error {
	flags := flag.NewFlagSet("credentials-status", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	_ = flags.String("data-dir", "", "locald data directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	deviceID, err := locald.LoadCredential("device-id")
	if errors.Is(err, locald.ErrCredentialNotFound) {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "deviceId": nil})
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "deviceId": strings.TrimSpace(deviceID)})
}

func runFingerprint(args []string) error {
	flags := flag.NewFlagSet("fingerprint", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "workspace root")
	spaceID := flags.String("space-id", "", "Space id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*root) == "" || strings.TrimSpace(*spaceID) == "" {
		return errors.New("--root and --space-id are required")
	}
	identity, err := locald.LoadOrCreateIdentity()
	if err != nil {
		return err
	}
	canonicalRoot, err := locald.CanonicalWorkspaceRoot(*root)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]string{"rootFingerprint": locald.RootFingerprint(identity, *spaceID, canonicalRoot)})
}

func runPermit(args []string) error {
	flags := flag.NewFlagSet("permit", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	spaceID := flags.String("space-id", "", "Space id")
	replicaID := flags.String("replica-id", "", "replica id")
	attemptID := flags.String("execution-attempt-id", "", "execution attempt id")
	baseSnapshotID := flags.String("base-snapshot-id", "", "base snapshot id")
	leaseEpoch := flags.Int64("lease-epoch", 0, "lease epoch")
	leaseHolderKind := flags.String("holder-kind", "local_agent", "lease holder kind")
	leaseHolderID := flags.String("holder-id", "", "lease holder id")
	expiresAt := flags.String("expires-at", "", "RFC3339 expiry")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	response, err := locald.SendRequest(context.Background(), cfg, locald.IPCRequest{
		Version:            1,
		Type:               "permit",
		SpaceID:            *spaceID,
		ReplicaID:          *replicaID,
		ExecutionAttemptID: *attemptID,
		BaseSnapshotID:     *baseSnapshotID,
		LeaseEpoch:         *leaseEpoch,
		LeaseHolderKind:    *leaseHolderKind,
		LeaseHolderID:      *leaseHolderID,
		ExpiresAt:          *expiresAt,
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}

func runRuntime(args []string) error {
	flags := flag.NewFlagSet("runtime", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	spaceID := flags.String("space-id", "", "Space id")
	runtimeID := flags.String("runtime-id", "", "registered local ACP runtime id")
	replicaID := flags.String("replica-id", "", "attached workspace replica id")
	provider := flags.String("provider", "", "provider name")
	root := flags.String("root", "", "local workspace root")
	relayURL := flags.String("relay", "", "Gateway runtime relay control url")
	providerCommand := flags.String("provider-command", "", "ACP provider adapter command")
	if err := flags.Parse(args); err != nil {
		return err
	}
	token, err := locald.LoadCredential("access-token")
	if err != nil || strings.TrimSpace(token) == "" {
		token = strings.TrimSpace(os.Getenv("COHUB_RUNTIME_TOKEN"))
	}
	if strings.TrimSpace(token) == "" {
		return errors.New("local ACP runtime access token is unavailable; refresh device credentials first")
	}
	_ = os.Unsetenv("COHUB_RUNTIME_TOKEN")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return locald.RunAcpRuntime(ctx, locald.AcpRuntimeOptions{
		RelayURL:        strings.TrimSpace(*relayURL),
		RelayToken:      strings.TrimSpace(token),
		DeviceID:        strings.TrimSpace(os.Getenv("COHUB_LOCAL_AGENT_DEVICE_ID")),
		RuntimeID:       strings.TrimSpace(*runtimeID),
		SpaceID:         strings.TrimSpace(*spaceID),
		ReplicaID:       strings.TrimSpace(*replicaID),
		Provider:        strings.TrimSpace(*provider),
		ProviderCommand: strings.TrimSpace(*providerCommand),
		WorkspaceDir:    strings.TrimSpace(*root),
		DataDir:         strings.TrimSpace(*dataDir),
		APIBaseURL:      strings.TrimSpace(os.Getenv("COHUB_API_URL")),
		Logger:          slog.Default(),
	})
}

func runSimpleIPC(kind string, args []string) error {
	flags := flag.NewFlagSet(kind, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "locald data directory")
	cwd := flags.String("cwd", "", "workspace current working directory")
	attemptID := flags.String("execution-attempt-id", "", "execution attempt id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	cfg := locald.ConfigFromEnvironment(*dataDir)
	request := locald.IPCRequest{Version: 1, Type: kind, CWD: *cwd, ExecutionAttemptID: *attemptID}
	var requestCtx context.Context = context.Background()
	cancel := func() {}
	if kind == "refresh" {
		requestCtx, cancel = context.WithTimeout(requestCtx, 30*time.Second)
	}
	defer cancel()
	response, err := locald.SendRequest(requestCtx, cfg, request)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}

func usage() {
	fmt.Fprintf(os.Stderr, "cohub-locald %s (%s/%s)\n", buildVersion, runtime.GOOS, runtime.GOARCH)
	fmt.Fprintln(os.Stderr, "usage: cohub-locald daemon|hook|collect-pi|configure|credentials|credentials-status|fingerprint|permit|runtime|preflight|status|refresh|flush")
}
