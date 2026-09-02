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

func TestAcpRuntimeForwardsPromptAndSessionUpdates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell provider fixture is Unix-only")
	}

	root := t.TempDir()
	provider := filepath.Join(t.TempDir(), "fake-acp.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":true}}}}'
      ;;
    *'"method":"session/new"'*)
      if printf '%s' "$line" | grep -Eq 'cohubRuntimeId|"mcpServers":\[[^]]|additionalDirectories'; then
        printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Cohub lifecycle metadata must not be forwarded"}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"acp-session-1"}}'
      fi
      ;;
    *'"method":"session/prompt"'*)
      if printf '%s' "$line" | grep -q 'cohubExecutionAttemptId'; then
        printf '%s\n' '{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"Cohub metadata leaked to provider"}}'
      else
        printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session-1","update":{"sessionUpdate":"agent_message_chunk","messageId":"message-1","content":{"type":"text","text":"fixture response"}}}}'
        printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
      fi
      ;;
  esac
done
`
	if err := os.WriteFile(provider, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	serverRuntimeID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	spaceID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	replicaID := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	attemptID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	baseSnapshotID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	finalizer := &Daemon{state: state, cfg: Config{DataDir: t.TempDir()}, client: &http.Client{Timeout: time.Second}}
	bridge := &acpRuntimeServer{
		options: AcpRuntimeOptions{
			RuntimeID:       serverRuntimeID,
			SpaceID:         spaceID,
			ReplicaID:       replicaID,
			Provider:        "pi",
			ProviderCommand: provider,
			WorkspaceDir:    root,
			Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		finalizer: finalizer,
	}

	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		bridge.ServeDialedConn(r.Context(), conn, "smoke")
	}))
	defer httpServer.Close()
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
		if writeErr := conn.Write(ctx, websocket.MessageText, append(raw, '\n')); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	readResponse := func(id float64) map[string]any {
		for {
			_, raw, readErr := conn.Read(ctx)
			if readErr != nil {
				t.Fatal(readErr)
			}
			var value map[string]any
			if err := json.Unmarshal(raw, &value); err != nil {
				t.Fatal(err)
			}
			if responseID, ok := value["id"].(float64); ok && responseID == id {
				return value
			}
		}
	}

	write(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": 1}})
	if response := readResponse(1); response["error"] != nil {
		t.Fatalf("initialize failed: %#v", response)
	}
	write(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace", "mcpServers": []any{}, "_meta": map[string]any{"cohubRuntimeId": serverRuntimeID}}})
	if response := readResponse(2); response["error"] != nil {
		t.Fatalf("session/new failed: %#v", response)
	}
	write(map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": "acp-session-1",
			"prompt":    []any{map[string]any{"type": "text", "text": "hello"}},
			"_meta": map[string]any{
				"cohubRuntimeId":          serverRuntimeID,
				"cohubSpaceId":            spaceID,
				"cohubReplicaId":          replicaID,
				"cohubExecutionAttemptId": attemptID,
				"cohubBaseSnapshotId":     baseSnapshotID,
				"cohubLeaseEpoch":         float64(1),
				"cohubLeaseExpiresAt":     time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
			},
		},
	})
	var updateSeen bool
	for {
		_, raw, readErr := conn.Read(ctx)
		if readErr != nil {
			t.Fatal(readErr)
		}
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		if value["method"] == "session/update" {
			updateSeen = strings.Contains(string(raw), "fixture response")
			continue
		}
		if responseID, ok := value["id"].(float64); ok && responseID == 3 {
			if value["error"] != nil {
				t.Fatalf("session/prompt failed: %#v", value)
			}
			break
		}
	}
	if !updateSeen {
		t.Fatal("provider session/update was not forwarded")
	}
	if _, err := state.PermitContext(attemptID); err != nil {
		t.Fatal(err)
	}
}
