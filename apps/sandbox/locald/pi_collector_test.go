package locald

import (
	"testing"
	"time"
)

func TestPICollectorBuildsPortableTurnWithoutProviderHiddenState(t *testing.T) {
	daemon := &Daemon{identity: []byte("0123456789abcdef0123456789abcdef")}
	replica := &ReplicaState{
		SpaceID:                  "space",
		ReplicaID:                "replica",
		DeviceID:                 "device",
		PolicyVersion:            2,
		IntegrationPolicyVersion: 3,
		MirrorMode:               "full",
		AppliedSnapshotID:        "snapshot",
	}
	permit := &PermitContext{
		ExecutionAttemptID: "attempt",
		BaseSnapshotID:     "snapshot",
		LeaseEpoch:         4,
		ExpiresAt:          time.Now().Add(time.Minute),
		Status:             "active",
	}
	bundle, err := daemon.buildPIBundle(replica, permit, piCollectorInput{
		ExecutionAttemptID: "attempt",
		NativeSessionID:    "raw-session",
		NativeTurnID:       "raw-turn",
		ProviderVersion:    "pi 0.81.1",
		Prompt:             "Fix the failing test",
		Messages: []map[string]any{
			{
				"role": "assistant",
				"id":   "raw-assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "visible reasoning"},
					map[string]any{"type": "toolCall", "id": "raw-tool", "name": "bash", "arguments": map[string]any{"command": "pnpm test", "authorization": "secret"}},
				},
				"usage": map[string]any{"input": float64(10), "output": float64(3), "cost": map[string]any{"total": 1}},
			},
			{
				"role":       "toolResult",
				"id":         "raw-result",
				"toolCallId": "raw-tool",
				"toolName":   "bash",
				"content":    []any{map[string]any{"type": "text", "text": "ok"}},
				"isError":    false,
			},
			{
				"role":    "assistant",
				"id":      "raw-final",
				"content": []any{map[string]any{"type": "text", "text": "Done"}},
			},
			{
				"role":    "system",
				"content": []any{map[string]any{"type": "text", "text": "hidden provider prompt"}},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bundle["nativeSessionKey"] == "raw-session" || bundle["nativeTurnKey"] == "raw-turn" {
		t.Fatal("raw native identifiers crossed the collector boundary")
	}
	history, ok := bundle["historyDelta"].([]any)
	if !ok || len(history) != 4 {
		t.Fatalf("unexpected portable history: %#v", bundle["historyDelta"])
	}
	assistant := history[1].(map[string]any)
	toolCalls := assistant["toolCalls"].([]any)
	arguments := toolCalls[0].(map[string]any)["arguments"].(map[string]any)
	if arguments["authorization"] != "[redacted]" {
		t.Fatalf("credential-like tool argument was not redacted: %#v", arguments)
	}
	for _, item := range history {
		entry := item.(map[string]any)
		if entry["role"] == "system" {
			t.Fatal("provider system content entered portable history")
		}
	}
}

func TestPICollectorRejectsUnknownFullMirrorTranscriptVersion(t *testing.T) {
	daemon := &Daemon{identity: []byte("0123456789abcdef0123456789abcdef")}
	replica := &ReplicaState{SpaceID: "space", ReplicaID: "replica", PolicyVersion: 1, IntegrationPolicyVersion: 1, MirrorMode: "full"}
	permit := &PermitContext{ExecutionAttemptID: "attempt", LeaseEpoch: 1, Status: "active"}
	_, err := daemon.buildPIBundle(replica, permit, piCollectorInput{
		ExecutionAttemptID: "attempt",
		NativeSessionID:    "session",
		NativeTurnID:       "turn",
		ProviderVersion:    "unknown",
		Prompt:             "test",
	})
	if err == nil {
		t.Fatal("expected unknown Pi transcript version to be rejected")
	}
}
