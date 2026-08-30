package locald

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func SendRequest(ctx context.Context, cfg Config, request IPCRequest) (IPCResponse, error) {
	cfg = cfg.normalize()
	if request.Version == 0 {
		request.Version = protocolVersion
	}
	conn, err := dialEndpoint(ctx, cfg.SocketPath)
	if err != nil {
		return IPCResponse{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return IPCResponse{}, fmt.Errorf("write locald IPC request: %w", err)
	}
	var response IPCResponse
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&response); err != nil {
		return IPCResponse{}, fmt.Errorf("read locald IPC response: %w", err)
	}
	if !response.OK && response.Code != "unbound" {
		return response, errors.New(response.Message)
	}
	return response, nil
}

func SendHook(ctx context.Context, cfg Config, request IPCRequest) (IPCResponse, error) {
	request.Type = "hook"
	response, err := SendRequest(ctx, cfg, request)
	if err == nil {
		return response, nil
	}
	// The hook process must remain useful when the daemon is stopped. It writes
	// an immutable local spool record and returns success; no network is attempted.
	state, stateErr := OpenState(cfg.DataDir)
	if stateErr != nil {
		return IPCResponse{}, fmt.Errorf("daemon unavailable and emergency spool failed: %w", stateErr)
	}
	defer state.Close()
	sanitized, sanitizeErr := sanitizePayload(request.Payload)
	if sanitizeErr != nil {
		return IPCResponse{}, fmt.Errorf("daemon unavailable and emergency hook redaction failed: %w", sanitizeErr)
	}
	eventID := randomEventID()
	payload := mustJSON(map[string]any{
		"kind":     "emergency_hook",
		"version":  protocolVersion,
		"eventId":  eventID,
		"provider": request.Provider,
		"event":    request.Event,
		"cwd":      request.CWD,
		"payload":  json.RawMessage(sanitized),
	})
	sequence, spoolErr := state.AppendSpool(eventID, payload)
	if spoolErr != nil {
		return IPCResponse{}, fmt.Errorf("daemon unavailable and emergency spool failed: %w", spoolErr)
	}
	return IPCResponse{Version: protocolVersion, OK: true, Code: "spooled", EventID: eventID, LocalReceiptSeq: sequence}, nil
}

func randomEventID() string {
	return uuid.NewString()
}
