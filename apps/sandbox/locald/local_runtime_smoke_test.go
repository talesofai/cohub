package locald

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLocalRuntimeForwardsNormalizedFrames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell host fixture is Unix-only")
	}

	root := t.TempDir()
	host := filepath.Join(t.TempDir(), "fake-runtime-host.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
	    *session.open*)
      printf '%s\n' '{"version":1,"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cohubSessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","executionAttemptId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turnId":null,"provider":"pi","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh","eventId":"11111111-1111-4111-8111-111111111111","sequence":1,"kind":"session.ready","payload":{"providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh"},"connectionEpoch":1}'
      ;;
	    *turn.start*)
      printf '%s\n' '{"version":1,"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cohubSessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","executionAttemptId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turnId":"99999999-9999-4999-8999-999999999999","provider":"pi","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh","eventId":"22222222-2222-4222-8222-222222222222","sequence":2,"kind":"text.delta","payload":{"text":"fixture response"},"connectionEpoch":1}'
      printf '%s\n' '{"version":1,"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cohubSessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","executionAttemptId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turnId":"99999999-9999-4999-8999-999999999999","provider":"pi","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh","eventId":"33333333-3333-4333-8333-333333333333","sequence":3,"kind":"turn.completed","payload":{"stopReason":"completed"},"connectionEpoch":1}'
      ;;
	    *session.close*)
      printf '%s\n' '{"version":1,"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cohubSessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","executionAttemptId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","turnId":null,"provider":"pi","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh","eventId":"44444444-4444-4444-8444-444444444444","sequence":4,"kind":"session.ready","payload":{"commandId":"session:dddddddd-dddd-4ddd-8ddd-dddddddddddd:ffffffff-ffff-4fff-8fff-ffffffffffff:close","operation":"session.close","status":"closed","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh"},"connectionEpoch":1}'
      ;;
  esac
done
`
	if err := os.WriteFile(host, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	const (
		serverRuntimeID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		spaceID         = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		replicaID       = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		deviceID        = "99999999-9999-4999-8999-999999999999"
		attemptID       = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		baseSnapshotID  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
		sessionID       = "ffffffff-ffff-4fff-8fff-ffffffffffff"
		cohubSessionID  = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
		providerID      = "hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh"
		turnID          = "99999999-9999-4999-8999-999999999999"
	)
	finalizer := &Daemon{state: state, cfg: Config{DataDir: t.TempDir(), AccessToken: "test-token"}, client: &http.Client{Timeout: time.Second}}
	server := &localRuntimeServer{
		options: LocalRuntimeOptions{
			RuntimeID:       serverRuntimeID,
			SpaceID:         spaceID,
			ReplicaID:       replicaID,
			Provider:        "pi",
			ProviderCommand: host,
			WorkspaceDir:    root,
			Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		finalizer: finalizer,
	}

	expiresAt := time.Now().UTC().Add(time.Minute)
	if err := state.UpsertReplica(ReplicaState{
		SpaceID:                  spaceID,
		ReplicaID:                replicaID,
		Root:                     root,
		RootFingerprint:          "fixture-root",
		DeviceID:                 deviceID,
		PolicyVersion:            1,
		IntegrationPolicyVersion: 1,
		CanonicalSnapshotID:      baseSnapshotID,
		AppliedSnapshotID:        baseSnapshotID,
		Generation:               1,
		Status:                   "ready",
		UpdatedAt:                time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	if err := state.PutPermit(attemptID, spaceID, replicaID, serverRuntimeID, baseSnapshotID, 1, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	binding, err := json.Marshal(map[string]any{
		"executionAttemptId": attemptID,
		"spaceId":            spaceID,
		"replicaId":          replicaID,
		"connectionEpoch":    1,
		"baseSnapshotId":     baseSnapshotID,
		"leaseEpoch":         1,
		"leaseExpiresAt":     expiresAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/state") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"replica": map[string]any{
					"spaceId": spaceID, "id": replicaID,
					"canonicalSnapshotId": baseSnapshotID, "appliedSnapshotId": baseSnapshotID,
					"status": "ready",
				},
				"workspace": map[string]any{
					"canonicalSnapshotId": baseSnapshotID,
				},
				"lease": map[string]any{
					"holderKind": "local_agent", "holderId": attemptID, "epoch": 1,
					"baseSnapshotId": baseSnapshotID, "expiresAt": expiresAt.Format(time.RFC3339Nano),
				},
				"executionAttempt": map[string]any{
					"id": attemptID, "spaceId": spaceID, "replicaId": replicaID,
					"runtimeId": serverRuntimeID, "deviceId": deviceID,
					"executorKind": "local_runtime", "status": "running",
					"baseSnapshotId": baseSnapshotID, "leaseEpoch": 1,
					"connectionEpoch": 1, "leaseExpiresAt": expiresAt.Format(time.RFC3339Nano),
				},
			})
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/leases/heartbeat") {
			var body struct {
				HolderKind string `json:"holderKind"`
				HolderID   string `json:"holderId"`
				RuntimeID  string `json:"runtimeId"`
				Epoch      int64  `json:"epoch"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode runtime lease heartbeat: %v", err)
			}
			if body.HolderKind != "local_agent" || body.HolderID != attemptID || body.RuntimeID != serverRuntimeID || body.Epoch != 1 {
				t.Fatalf("unexpected runtime lease heartbeat: %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"expiresAt": time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339Nano)})
			return
		}
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		server.ServeChannel(r.Context(), conn, "smoke", binding)
	}))
	defer httpServer.Close()
	finalizer.cfg.APIBaseURL = httpServer.URL
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	write := func(value map[string]any) {
		raw, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if writeErr := conn.Write(ctx, websocket.MessageText, raw); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	readEvent := func(kind string) string {
		for {
			_, raw, readErr := conn.Read(ctx)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if len(raw) == 0 || raw[len(raw)-1] != '\n' {
				t.Fatalf("runtime event frame lost its LF delimiter: %q", raw)
			}
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatal(err)
			}
			if value["kind"] == kind {
				return string(raw)
			}
		}
	}

	base := map[string]any{
		"version":            1,
		"type":               "command",
		"runtimeId":          serverRuntimeID,
		"spaceId":            spaceID,
		"runtimeSessionId":   sessionID,
		"cohubSessionId":     cohubSessionID,
		"executionAttemptId": attemptID,
		"provider":           "pi",
		"cwd":                root,
		"accessMode":         "full_access",
		"connectionEpoch":    1,
	}
	open := cloneRuntimeMap(base)
	open["commandId"] = "open-command"
	open["turnId"] = nil
	open["providerSessionId"] = nil
	open["operation"] = "session.open"
	open["payload"] = map[string]any{}
	write(open)
	if response := readEvent("session.ready"); !strings.Contains(response, providerID) {
		t.Fatalf("unexpected session event: %s", response)
	}

	turn := cloneRuntimeMap(base)
	turn["commandId"] = "turn-command"
	turn["turnId"] = turnID
	turn["providerSessionId"] = providerID
	turn["operation"] = "turn.start"
	turn["payload"] = map[string]any{"text": "hello"}
	write(turn)
	if response := readEvent("text.delta"); !strings.Contains(response, "fixture response") {
		t.Fatalf("normalized text event was not forwarded: %s", response)
	}
	readEvent("turn.completed")
	closeCommand := cloneRuntimeMap(base)
	closeCommand["commandId"] = "session:" + attemptID + ":" + sessionID + ":close"
	closeCommand["turnId"] = nil
	closeCommand["providerSessionId"] = providerID
	closeCommand["operation"] = "session.close"
	closeCommand["payload"] = map[string]any{}
	write(closeCommand)
	for {
		response := readEvent("session.ready")
		var event map[string]any
		if err := json.Unmarshal([]byte(response), &event); err != nil {
			t.Fatal(err)
		}
		payload, _ := event["payload"].(map[string]any)
		if payload["status"] == "closed" && payload["hostReaped"] == true {
			break
		}
	}

	permit, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if permit == nil || permit.Status != "active" || !isLocalRuntimePermit(permit.HolderID) {
		t.Fatalf("channel binding did not claim the execution permit: %#v", permit)
	}
}

func cloneRuntimeMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}
