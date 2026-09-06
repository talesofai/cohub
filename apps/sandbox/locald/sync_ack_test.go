package locald

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSyncReplicaReplaysAppliedAckAfterNetworkLoss(t *testing.T) {
	store, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	root := t.TempDir()
	if err := store.UpsertReplica(ReplicaState{
		SpaceID: "space", ReplicaID: "replica", Root: root, RootFingerprint: "fingerprint",
		DeviceID: "device", PolicyVersion: 1, IntegrationPolicyVersion: 1,
		InitialChoice: "use-cloud", CanonicalSnapshotID: "canonical", AppliedSnapshotID: "canonical",
		Generation: 7, Status: "ready", Manifest: []byte(`{"version":1}`), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	ackCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer token" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch request.Method {
		case http.MethodGet:
			_ = json.NewEncoder(response).Encode(map[string]any{
				"replica": map[string]any{
					"id": "replica", "currentSnapshotId": "canonical", "appliedSnapshotId": nil, "status": "syncing",
				},
				"workspace": map[string]any{
					"canonicalSnapshotId": "canonical", "generation": 7, "status": "ready",
				},
				"workspacePolicy": map[string]any{
					"policyVersion": 1, "defaultExcludes": []any{}, "customExcludes": []any{},
					"sensitiveContentMode": "exclude_with_warning", "limits": map[string]any{},
				},
				"integrationPolicy": map[string]any{
					"integrationPolicyVersion": 1,
				},
			})
		case http.MethodPost:
			ackCount++
			var payload struct {
				Generation int64 `json:"generation"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil || payload.Generation != 7 {
				http.Error(response, "bad acknowledgement", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"ok": true})
		default:
			http.Error(response, "unexpected method", http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	daemon := &Daemon{
		cfg:    Config{APIBaseURL: server.URL, AccessToken: "token", DataDir: t.TempDir()},
		state:  store,
		client: server.Client(),
	}
	replica, err := store.ReplicaForSpace("space")
	if err != nil {
		t.Fatal(err)
	}
	if err := daemon.syncReplica(context.Background(), replica); err != nil {
		t.Fatal(err)
	}
	if ackCount != 1 {
		t.Fatalf("expected one replayed applied acknowledgement, got %d", ackCount)
	}
}
