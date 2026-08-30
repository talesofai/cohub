package locald

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProviderPayloadRedactsPathsAndScopesRawIdentifiers(t *testing.T) {
	identity := []byte("0123456789abcdef0123456789abcdef")
	input := map[string]any{
		"session_id":      "raw-session",
		"turnId":          "raw-turn",
		"toolCallId":      "raw-tool",
		"transcript_path": "/home/alice/.claude/session.jsonl",
		"nested": map[string]any{
			"messageId": "raw-message",
		},
	}
	result := sanitizeProviderPayloadIdentifiers(input, identity, "space", "replica", "claude_code").(map[string]any)
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, secret := range []string{"raw-session", "raw-turn", "raw-tool", "raw-message", "/home/alice"} {
		if strings.Contains(text, secret) {
			t.Fatalf("provider identity or path leaked after sanitization: %s", text)
		}
	}
	if result["transcript_path"] != "[redacted-path]" {
		t.Fatalf("absolute transcript path was not redacted: %#v", result)
	}
	if result["nativeSessionKey"] == nil || result["nativeTurnKey"] == nil || result["nativeToolKey"] == nil {
		t.Fatalf("scoped provider identifiers were not retained: %#v", result)
	}
}

func TestMetadataOnlyHookPayloadDropsContent(t *testing.T) {
	result := metadataOnlyHookPayload(map[string]any{
		"prompt":    "private prompt",
		"arguments": map[string]any{"command": "secret command"},
		"status":    "completed",
		"isError":   false,
	})
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "private prompt") || strings.Contains(text, "secret command") {
		t.Fatalf("metadata-only payload retained content: %s", text)
	}
	if result["payloadSha256"] == nil || result["status"] != "completed" {
		t.Fatalf("metadata-only lifecycle facts are incomplete: %#v", result)
	}
}

func TestNormalizeProviderHookCamelCaseLifecycle(t *testing.T) {
	cases := map[string]string{
		"SessionStart":     "session_started",
		"UserPromptSubmit": "prompt_submitted",
		"PostToolUse":      "tool_finished",
		"Stop":             "turn_stopped",
		"StopFailure":      "turn_failed",
		"PreCompact":       "session_compacted",
		"SessionEnd":       "session_ended",
	}
	for event, expected := range cases {
		actual, err := normalizeHookType(event)
		if err != nil {
			t.Fatalf("normalize %s: %v", event, err)
		}
		if actual != expected {
			t.Fatalf("normalize %s = %s, want %s", event, actual, expected)
		}
	}
}
