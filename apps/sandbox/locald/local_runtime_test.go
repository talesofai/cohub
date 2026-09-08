package locald

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testLeaseRuntimeID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

func writeLeaseRuntimeState(writer http.ResponseWriter, attemptID, replicaID string) {
	writer.Header().Set("content-type", "application/json")
	_, _ = writer.Write([]byte(fmt.Sprintf(`{"executionAttempt":{"id":%q,"spaceId":"11111111-1111-4111-8111-111111111111","replicaId":%q,"runtimeId":%q}}`, attemptID, replicaID, testLeaseRuntimeID)))
}

func TestRuntimeIDForPermitUsesPersistedIdentityWithoutStateLookup(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 1, time.Now().UTC().Add(time.Minute), "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read permit: %v %#v", err, permit)
	}
	runtimeID, err := runtimeIDForPermit(permit)
	if err != nil {
		t.Fatal(err)
	}
	if runtimeID != testLeaseRuntimeID {
		t.Fatalf("unexpected persisted runtime identity: %q", runtimeID)
	}
}

func TestRuntimeIDForPermitStateSurvivesTerminalAttemptOmission(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 1, time.Now().UTC().Add(time.Minute), "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read permit: %v %#v", err, permit)
	}
	runtimeID, err := runtimeIDForPermitState(permit, remoteReplicaState{})
	if err != nil {
		t.Fatal(err)
	}
	if runtimeID != testLeaseRuntimeID {
		t.Fatalf("unexpected persisted runtime identity: %q", runtimeID)
	}
}

func TestCopyRuntimeStderrDrainsOversizedLine(t *testing.T) {
	reader, writer := io.Pipe()
	done := make(chan struct{})
	go func() {
		copyRuntimeStderr(slog.New(slog.NewTextHandler(io.Discard, nil)), reader, "test")
		close(done)
	}()

	writeDone := make(chan error, 1)
	go func() {
		_, err := writer.Write(bytes.Repeat([]byte("x"), 2*1024*1024))
		_ = writer.Close()
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("write stderr fixture: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stderr writer blocked after an oversized diagnostic line")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stderr drain did not finish after the pipe closed")
	}
}

func testBinding(t *testing.T, mutate func(map[string]any)) json.RawMessage {
	t.Helper()
	binding := map[string]any{
		"executionAttemptId": "33333333-3333-4333-8333-333333333333",
		"spaceId":            "11111111-1111-4111-8111-111111111111",
		"replicaId":          "22222222-2222-4222-8222-222222222222",
		"connectionEpoch":    3,
		"baseSnapshotId":     "44444444-4444-4444-8444-444444444444",
		"leaseEpoch":         7,
		"leaseExpiresAt":     time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
	}
	if mutate != nil {
		mutate(binding)
	}
	raw, err := json.Marshal(binding)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseChannelBindingValidatesRuntimeIdentity(t *testing.T) {
	ref, err := parseChannelBinding(testBinding(t, nil), "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	if ref.attemptID != "33333333-3333-4333-8333-333333333333" || ref.runtimeID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || ref.leaseEpoch != 7 || ref.baseSnapshotID != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("unexpected binding: %#v", ref)
	}
}

func TestParseChannelBindingRejectsStaleOrMismatchedBinding(t *testing.T) {
	space := "11111111-1111-4111-8111-111111111111"
	replica := "22222222-2222-4222-8222-222222222222"
	runtimeID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if _, err := parseChannelBinding(testBinding(t, nil), "99999999-9999-4999-8999-999999999999", replica, runtimeID); err == nil {
		t.Fatal("expected Space mismatch to be rejected")
	}
	if _, err := parseChannelBinding(testBinding(t, nil), space, "99999999-9999-4999-8999-999999999999", runtimeID); err == nil {
		t.Fatal("expected replica mismatch to be rejected")
	}
	if _, err := parseChannelBinding(testBinding(t, func(b map[string]any) {
		b["leaseExpiresAt"] = time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano)
	}), space, replica, runtimeID); err == nil {
		t.Fatal("expected expired lease to be rejected")
	}
	if _, err := parseChannelBinding(testBinding(t, func(b map[string]any) { b["executionAttemptId"] = "attempt" }), space, replica, runtimeID); err == nil {
		t.Fatal("expected invalid attempt UUID to be rejected")
	}
	if _, err := parseChannelBinding(testBinding(t, func(b map[string]any) { b["leaseEpoch"] = 0 }), space, replica, runtimeID); err == nil {
		t.Fatal("expected zero lease epoch to be rejected")
	}
	if _, err := parseChannelBinding(nil, space, replica, runtimeID); err == nil {
		t.Fatal("expected a missing binding to be rejected")
	}
	if _, err := parseChannelBinding(testBinding(t, nil), space, replica, " "); err == nil {
		t.Fatal("expected a missing registered runtime identity to be rejected")
	}
}

func TestRefreshLocalRuntimePermitRejectsAttemptFromAnotherRuntime(t *testing.T) {
	const (
		attemptID      = "33333333-3333-4333-8333-333333333333"
		spaceID        = "11111111-1111-4111-8111-111111111111"
		replicaID      = "22222222-2222-4222-8222-222222222222"
		baseSnapshotID = "44444444-4444-4444-8444-444444444444"
		deviceID       = "55555555-5555-4555-8555-555555555555"
		runtimeID      = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		otherRuntimeID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := state.UpsertReplica(ReplicaState{
		SpaceID:             spaceID,
		ReplicaID:           replicaID,
		Root:                t.TempDir(),
		RootFingerprint:     "root-fingerprint",
		DeviceID:            deviceID,
		CanonicalSnapshotID: baseSnapshotID,
		AppliedSnapshotID:   baseSnapshotID,
		Status:              "ready",
	}); err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().UTC().Add(time.Minute)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/local-agent/spaces/"+spaceID+"/replicas/"+replicaID+"/state" {
			t.Fatalf("unexpected state path: %s", request.URL.Path)
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"replica": map[string]any{
				"spaceId": spaceID, "id": replicaID,
				"canonicalSnapshotId": baseSnapshotID, "appliedSnapshotId": baseSnapshotID,
				"status": "ready",
			},
			"workspace": map[string]any{"canonicalSnapshotId": baseSnapshotID},
			"lease": map[string]any{
				"holderKind": "local_agent", "holderId": attemptID, "epoch": 1,
				"baseSnapshotId": baseSnapshotID, "expiresAt": expiresAt.Format(time.RFC3339Nano),
			},
			"executionAttempt": map[string]any{
				"id": attemptID, "spaceId": spaceID, "replicaId": replicaID,
				"runtimeId": otherRuntimeID, "deviceId": deviceID,
				"executorKind": "local_runtime", "status": "running",
				"baseSnapshotId": baseSnapshotID, "leaseEpoch": 1,
				"connectionEpoch": 1, "leaseExpiresAt": expiresAt.Format(time.RFC3339Nano),
			},
		})
	}))
	defer server.Close()
	daemon := &Daemon{
		cfg:    Config{APIBaseURL: server.URL, AccessToken: "test-token"},
		state:  state,
		client: server.Client(),
	}
	ref := runtimeAttemptRef{
		attemptID:       attemptID,
		spaceID:         spaceID,
		replicaID:       replicaID,
		runtimeID:       runtimeID,
		connectionEpoch: 1,
		baseSnapshotID:  baseSnapshotID,
		leaseEpoch:      1,
		expiresAt:       expiresAt,
	}
	if err := daemon.refreshLocalRuntimePermit(context.Background(), ref); err == nil {
		t.Fatal("expected an execution attempt owned by another runtime to be rejected")
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if permit != nil {
		t.Fatalf("mismatched runtime attempt prepared a local permit: %#v", permit)
	}
}

func TestLocalRuntimePermitIsOneUse(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	server := &localRuntimeServer{
		options:   LocalRuntimeOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		finalizer: &Daemon{state: state},
	}
	ref := runtimeAttemptRef{
		attemptID:      "33333333-3333-4333-8333-333333333333",
		spaceID:        "11111111-1111-4111-8111-111111111111",
		replicaID:      "22222222-2222-4222-8222-222222222222",
		runtimeID:      testLeaseRuntimeID,
		baseSnapshotID: "44444444-4444-4444-8444-444444444444",
		leaseEpoch:     1,
		expiresAt:      time.Now().UTC().Add(time.Minute),
	}
	if err := state.PutPermit(ref.attemptID, ref.spaceID, ref.replicaID, ref.runtimeID, ref.baseSnapshotID, ref.leaseEpoch, ref.expiresAt, "local_agent", ref.attemptID); err != nil {
		t.Fatal(err)
	}
	if err := server.startAttempt(ref); err != nil {
		t.Fatal(err)
	}
	if err := server.startAttempt(ref); err == nil {
		t.Fatal("expected a consumed local runtime permit to reject a duplicate channel")
	}
	permit, err := state.PermitContext(ref.attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if permit == nil || !isLocalRuntimePermit(permit.HolderID) || serverPermitHolderID(permit.HolderID) != ref.attemptID {
		t.Fatalf("unexpected local runtime permit holder identity: %#v", permit)
	}
	if _, _, valid, err := (&Daemon{state: state}).activePermit(ref.spaceID); err != nil || !valid {
		t.Fatalf("active local runtime permit must block local sync: valid=%v err=%v", valid, err)
	}
	server.finishAttempt(ref, true)
	spool, err := state.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(spool) != 1 || spool[0].EventID != "workspace-terminal:"+ref.attemptID {
		t.Fatalf("expected durable local runtime terminal spool record, got %#v", spool)
	}
}

func TestPutPermitCannotResetConsumedPermit(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	expiresAt := time.Now().UTC().Add(time.Minute)
	const (
		attemptID = "77777777-7777-4777-8777-777777777777"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		runtimeID = testLeaseRuntimeID
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	if err := state.PutPermit(attemptID, spaceID, replicaID, runtimeID, baseID, 1, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, runtimeID, baseID, 1, expiresAt); err != nil {
		t.Fatal(err)
	}
	if err := state.PutPermit(attemptID, spaceID, replicaID, runtimeID, baseID, 2, expiresAt.Add(time.Minute), "local_agent", attemptID); err == nil {
		t.Fatal("consumed permit was re-prepared")
	}
}

func TestPutPermitRejectsCallerSelectedHolder(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := state.PutPermit("88888888-8888-4888-8888-888888888888", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", testLeaseRuntimeID, "44444444-4444-4444-8444-444444444444", 1, time.Now().UTC().Add(time.Minute), "cloud_agent", "forged"); err == nil {
		t.Fatal("caller-selected permit holder was accepted")
	}
}

func TestLocalRuntimeDoesNotSpoolWithoutTerminalEvidence(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	server := &localRuntimeServer{
		options:   LocalRuntimeOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		finalizer: &Daemon{state: state},
	}
	ref := runtimeAttemptRef{
		attemptID:      "66666666-6666-4666-8666-666666666666",
		spaceID:        "11111111-1111-4111-8111-111111111111",
		replicaID:      "22222222-2222-4222-8222-222222222222",
		baseSnapshotID: "44444444-4444-4444-8444-444444444444",
		leaseEpoch:     1,
		expiresAt:      time.Now().UTC().Add(time.Minute),
	}
	server.finishAttempt(ref, false)
	spool, err := state.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(spool) != 0 {
		t.Fatalf("unexpected finalization evidence without a terminal event: %#v", spool)
	}
}

func TestIsRuntimeTerminalEvent(t *testing.T) {
	if !isRuntimeTerminalEvent([]byte(`{"type":"event","kind":"turn.completed"}`)) {
		t.Fatal("turn.completed should be terminal evidence")
	}
	if !isRuntimeTerminalEvent([]byte(`{"type":"event","kind":"turn.failed"}`)) {
		t.Fatal("turn.failed should be terminal evidence")
	}
	for _, input := range []string{
		`{"type":"event","kind":"session.ready"}`,
		`{"type":"command","kind":"turn.completed"}`,
		`not-json`,
	} {
		if isRuntimeTerminalEvent([]byte(input)) {
			t.Fatalf("non-terminal frame was accepted: %s", input)
		}
	}
}

func TestIsRuntimeTerminalEventForAttemptRequiresChannelIdentity(t *testing.T) {
	ref := runtimeAttemptRef{attemptID: "33333333-3333-4333-8333-333333333333", connectionEpoch: 4}
	line := func(runtimeID, attemptID string, epoch int64) []byte {
		return []byte(`{"type":"event","runtimeId":"` + runtimeID + `","executionAttemptId":"` + attemptID + `","connectionEpoch":` + fmt.Sprint(epoch) + `,"kind":"turn.completed"}`)
	}
	if !isRuntimeTerminalEventForAttempt(line("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref.attemptID, ref.connectionEpoch), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref) {
		t.Fatal("matching terminal event should be accepted")
	}
	for _, event := range [][]byte{
		line("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ref.attemptID, ref.connectionEpoch),
		line("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "66666666-6666-4666-8666-666666666666", ref.connectionEpoch),
		line("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref.attemptID, ref.connectionEpoch+1),
		[]byte(`{"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","executionAttemptId":"33333333-3333-4333-8333-333333333333","connectionEpoch":4,"kind":"session.ready"}`),
	} {
		if isRuntimeTerminalEventForAttempt(event, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref) {
			t.Fatalf("mismatched terminal event was accepted: %s", event)
		}
	}
}

func TestValidateRuntimeCommandForChannelPinsExecutionAttempt(t *testing.T) {
	ref := runtimeAttemptRef{
		runtimeID:       "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		spaceID:         "11111111-1111-4111-8111-111111111111",
		attemptID:       "33333333-3333-4333-8333-333333333333",
		connectionEpoch: 4,
	}
	command := func(runtimeID, spaceID, attemptID string, epoch int64) []byte {
		return []byte(fmt.Sprintf(`{"type":"command","runtimeId":%q,"spaceId":%q,"executionAttemptId":%q,"connectionEpoch":%d}`, runtimeID, spaceID, attemptID, epoch))
	}
	if err := validateRuntimeCommandForChannel(command(ref.runtimeID, ref.spaceID, ref.attemptID, ref.connectionEpoch), ref); err != nil {
		t.Fatalf("matching command was rejected: %v", err)
	}
	for name, line := range map[string][]byte{
		"runtime":    command("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ref.spaceID, ref.attemptID, ref.connectionEpoch),
		"space":      command(ref.runtimeID, "22222222-2222-4222-8222-222222222222", ref.attemptID, ref.connectionEpoch),
		"attempt":    command(ref.runtimeID, ref.spaceID, "66666666-6666-4666-8666-666666666666", ref.connectionEpoch),
		"epoch":      command(ref.runtimeID, ref.spaceID, ref.attemptID, ref.connectionEpoch+1),
		"null":       []byte(fmt.Sprintf(`{"type":"command","runtimeId":%q,"spaceId":%q,"executionAttemptId":null,"connectionEpoch":%d}`, ref.runtimeID, ref.spaceID, ref.connectionEpoch)),
		"noncommand": []byte(fmt.Sprintf(`{"type":"event","runtimeId":%q,"spaceId":%q,"executionAttemptId":%q,"connectionEpoch":%d}`, ref.runtimeID, ref.spaceID, ref.attemptID, ref.connectionEpoch)),
	} {
		if err := validateRuntimeCommandForChannel(line, ref); err == nil {
			t.Fatalf("%s frame was accepted", name)
		}
	}
}

func TestRuntimeSessionCloseAckRequiresCommandIdentity(t *testing.T) {
	ref := runtimeAttemptRef{
		attemptID:       "33333333-3333-4333-8333-333333333333",
		connectionEpoch: 4,
	}
	line := []byte(`{"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","executionAttemptId":"33333333-3333-4333-8333-333333333333","connectionEpoch":4,"kind":"session.ready","payload":{"commandId":"close-1","operation":"session.close","status":"closed"}}`)
	if !isRuntimeSessionCloseAckForAttempt(line, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref, "close-1") {
		t.Fatal("matching close acknowledgement should be accepted")
	}
	if isRuntimeSessionCloseAckForAttempt(line, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ref, "close-2") {
		t.Fatal("close acknowledgement for another command was accepted")
	}
	if isRuntimeSessionCloseAckForAttempt(line, "", ref, "close-1") {
		t.Fatal("close acknowledgement without a runtime identity was accepted")
	}
}

func TestHostReapedRuntimeEventPreservesEnvelope(t *testing.T) {
	raw := []byte(`{"version":1,"type":"event","runtimeId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runtimeSessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cohubSessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","executionAttemptId":"33333333-3333-4333-8333-333333333333","turnId":null,"provider":"pi","providerSessionId":"hhhhhhhh-hhhh-4hhh-8hhh-hhhhhhhhhhhh","providerEventId":"provider-close","eventId":"11111111-1111-4111-8111-111111111111","sequence":4,"kind":"session.ready","payload":{"commandId":"close-1","operation":"session.close","status":"closed"},"connectionEpoch":4}`)
	reaped, err := hostReapedRuntimeEvent(raw)
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(reaped, &event); err != nil {
		t.Fatal(err)
	}
	if event["eventId"] == "11111111-1111-4111-8111-111111111111" || event["providerEventId"] != nil || event["sequence"] != float64(5) {
		t.Fatalf("synthetic event identity was not regenerated: %#v", event)
	}
	payload, ok := event["payload"].(map[string]any)
	if !ok || payload["hostReaped"] != true || payload["commandId"] != "close-1" {
		t.Fatalf("synthetic event payload is invalid: %#v", event["payload"])
	}
	for _, key := range []string{"runtimeId", "runtimeSessionId", "cohubSessionId", "executionAttemptId", "providerSessionId", "connectionEpoch"} {
		if _, ok := event[key]; !ok {
			t.Fatalf("synthetic event dropped required field %q", key)
		}
	}
}

func TestLocalRuntimePermitHeartbeatIsScopedToLiveAttempt(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	attemptID := "55555555-5555-4555-8555-555555555555"
	expiresAt := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", testLeaseRuntimeID, "44444444-4444-4444-8444-444444444444", 1, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", testLeaseRuntimeID, "44444444-4444-4444-8444-444444444444", 1, expiresAt); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	(&Daemon{state: state}).heartbeatLocalRuntimePermits(ctx, func(string) bool { return false })
	permit, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if permit == nil || !permit.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("orphan local runtime permit was renewed: %#v", permit)
	}
}

func TestLocalRuntimeFinalizationRequiresInitialServerHeartbeat(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/api/local-agent/spaces/11111111-1111-4111-8111-111111111111/replicas/22222222-2222-4222-8222-222222222222/state":
			writeLeaseRuntimeState(writer, "33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
			return
		case "/api/local-agent/spaces/11111111-1111-4111-8111-111111111111/leases/heartbeat", "/api/local-agent/spaces/11111111-1111-4111-8111-111111111111/leases/acquire":
			// Both the initial heartbeat and its one-shot recovery must fail
			// closed; finalization must not proceed under either response.
		default:
			t.Fatalf("unexpected lease path: %s", request.URL.Path)
		}
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"code":"workspace_lease_lost"}`))
	}))
	defer server.Close()

	daemon := &Daemon{
		cfg:    Config{APIBaseURL: server.URL, AccessToken: "test-token"},
		state:  state,
		client: server.Client(),
	}
	permit := &PermitContext{
		ExecutionAttemptID: "33333333-3333-4333-8333-333333333333",
		SpaceID:            "11111111-1111-4111-8111-111111111111",
		ReplicaID:          "22222222-2222-4222-8222-222222222222",
		RuntimeID:          testLeaseRuntimeID,
		BaseSnapshotID:     "44444444-4444-4444-8444-444444444444",
		LeaseEpoch:         1,
		ExpiresAt:          time.Now().UTC().Add(time.Minute),
		HolderKind:         "local_agent",
		HolderID:           localRuntimePermitHolderID("33333333-3333-4333-8333-333333333333"),
		Status:             "active",
	}
	if _, err := daemon.startLocalRuntimeLeaseHeartbeat(context.Background(), permit.SpaceID, permit); err == nil {
		t.Fatal("expected initial heartbeat failure to abort finalization")
	}
	if requests != 2 {
		t.Fatalf("expected heartbeat and recovery request, got %d", requests)
	}
}

func TestLocalRuntimeLeaseRecoveryRenewsActivePermit(t *testing.T) {
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	originalExpiry := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, originalExpiry, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, originalExpiry); err != nil {
		t.Fatal(err)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read active permit: %v %#v", err, permit)
	}
	recoveryExpiry := time.Now().UTC().Add(2 * time.Minute)
	requests := 0
	heartbeatRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/api/local-agent/spaces/" + spaceID + "/replicas/" + replicaID + "/state":
			writeLeaseRuntimeState(writer, attemptID, replicaID)
		case "/api/local-agent/spaces/" + spaceID + "/leases/heartbeat":
			heartbeatRequests++
			if heartbeatRequests == 1 {
				writer.WriteHeader(http.StatusConflict)
				_, _ = writer.Write([]byte(`{"code":"workspace_lease_lost"}`))
				return
			}
			if heartbeatRequests != 2 {
				t.Fatalf("unexpected heartbeat request number %d", heartbeatRequests)
			}
			_, _ = writer.Write([]byte(fmt.Sprintf(`{"expiresAt":%q}`, recoveryExpiry.Add(10*time.Second).Format(time.RFC3339Nano))))
		case "/api/local-agent/spaces/" + spaceID + "/leases/acquire":
			var body struct {
				HolderKind      string `json:"holderKind"`
				HolderID        string `json:"holderId"`
				RuntimeID       string `json:"runtimeId"`
				ReplicaID       string `json:"replicaId"`
				BaseSnapshotID  string `json:"baseSnapshotId"`
				DurationSeconds int    `json:"durationSeconds"`
				Recovery        bool   `json:"recovery"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode recovery request: %v", err)
			}
			if body.HolderKind != "local_agent" || body.HolderID != attemptID || body.RuntimeID != testLeaseRuntimeID || body.ReplicaID != replicaID || body.BaseSnapshotID != baseID || body.DurationSeconds != 30 || !body.Recovery {
				t.Fatalf("unexpected recovery request: %#v", body)
			}
			_, _ = writer.Write([]byte(fmt.Sprintf(`{"spaceId":%q,"holderKind":"local_agent","holderId":%q,"epoch":7,"baseSnapshotId":%q,"expiresAt":%q}`, spaceID, attemptID, baseID, recoveryExpiry.Format(time.RFC3339Nano))))
		default:
			t.Fatalf("unexpected request path: %s", request.URL.Path)
		}
	}))
	defer server.Close()
	daemon := &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()}

	heartbeat, err := daemon.startLocalRuntimeLeaseHeartbeat(context.Background(), spaceID, permit)
	if err != nil {
		t.Fatalf("recover local runtime lease: %v", err)
	}
	heartbeat.stop()
	if requests != 3 {
		t.Fatalf("expected heartbeat, recovery, heartbeat, got %d requests", requests)
	}
	refreshed, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed == nil || refreshed.Status != "active" || !refreshed.ExpiresAt.After(originalExpiry) {
		t.Fatalf("active permit was not renewed: %#v", refreshed)
	}
}

func TestLocalRuntimeLeaseRecoveryRejectsMismatchedResponse(t *testing.T) {
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	originalExpiry := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, originalExpiry, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, originalExpiry); err != nil {
		t.Fatal(err)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read active permit: %v %#v", err, permit)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path == "/api/local-agent/spaces/"+spaceID+"/replicas/"+replicaID+"/state" {
			writeLeaseRuntimeState(writer, attemptID, replicaID)
			return
		}
		if request.URL.Path == "/api/local-agent/spaces/"+spaceID+"/leases/heartbeat" {
			writer.WriteHeader(http.StatusConflict)
			_, _ = writer.Write([]byte(`{"code":"workspace_lease_lost"}`))
			return
		}
		if request.URL.Path != "/api/local-agent/spaces/"+spaceID+"/leases/acquire" {
			t.Fatalf("unexpected request path: %s", request.URL.Path)
		}
		_, _ = writer.Write([]byte(fmt.Sprintf(`{"spaceId":%q,"holderKind":"local_agent","holderId":%q,"epoch":8,"baseSnapshotId":%q,"expiresAt":%q}`, spaceID, attemptID, baseID, time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano))))
	}))
	defer server.Close()
	daemon := &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()}
	if _, err := daemon.startLocalRuntimeLeaseHeartbeat(context.Background(), spaceID, permit); err == nil {
		t.Fatal("mismatched recovery epoch was accepted")
	}
	if requests != 2 {
		t.Fatalf("expected heartbeat and one recovery request, got %d", requests)
	}
	unchanged, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged == nil || unchanged.Status != "active" || !unchanged.ExpiresAt.Equal(originalExpiry) {
		t.Fatalf("mismatched recovery response changed the permit: %#v", unchanged)
	}
}

func TestLocalRuntimeLeaseRecoveryFailureKeepsSpoolFenced(t *testing.T) {
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	expiresAt := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, expiresAt); err != nil {
		t.Fatal(err)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read active permit: %v %#v", err, permit)
	}
	if _, err := state.AppendSpool("workspace-terminal:"+attemptID, []byte(`{"kind":"workspace_terminal"}`)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/local-agent/spaces/"+spaceID+"/replicas/"+replicaID+"/state" {
			writeLeaseRuntimeState(writer, attemptID, replicaID)
			return
		}
		if request.URL.Path == "/api/local-agent/spaces/"+spaceID+"/leases/heartbeat" || request.URL.Path == "/api/local-agent/spaces/"+spaceID+"/leases/acquire" {
			writer.WriteHeader(http.StatusConflict)
			_, _ = writer.Write([]byte(`{"code":"workspace_lease_lost"}`))
			return
		}
		t.Fatalf("unexpected request path: %s", request.URL.Path)
	}))
	defer server.Close()
	daemon := &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()}
	if _, err := daemon.startLocalRuntimeLeaseHeartbeat(context.Background(), spaceID, permit); err == nil {
		t.Fatal("expected failed recovery to keep finalization fenced")
	}
	unchanged, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged == nil || unchanged.Status != "active" {
		t.Fatalf("failed recovery changed permit status: %#v", unchanged)
	}
	spool, err := state.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(spool) != 1 || spool[0].EventID != "workspace-terminal:"+attemptID {
		t.Fatalf("failed recovery retired the terminal spool: %#v", spool)
	}
}

func TestLocalRuntimeStartFailureReleasesAttemptAndPermit(t *testing.T) {
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	expiresAt := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 3, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 3, expiresAt); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		wantPath := "/api/local-agent/spaces/" + spaceID + "/replicas/" + replicaID + "/attempts/" + attemptID + "/fail-before-start"
		if request.Method != http.MethodPost || request.URL.Path != wantPath {
			t.Fatalf("unexpected start failure request: %s %s", request.Method, request.URL.Path)
		}
		var body struct {
			RuntimeID    string `json:"runtimeId"`
			LeaseEpoch   int64  `json:"leaseEpoch"`
			ErrorMessage string `json:"errorMessage"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.RuntimeID != testLeaseRuntimeID || body.LeaseEpoch != 3 || body.ErrorMessage == "" {
			t.Fatalf("unexpected start failure payload: %#v", body)
		}
		_, _ = writer.Write([]byte(`{"status":"failed"}`))
	}))
	defer server.Close()
	daemon := &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()}
	if err := daemon.failLocalRuntimeAttemptBeforeStart(context.Background(), spoolEnvelope{
		Kind:               "runtime_start_failed",
		SpaceID:            spaceID,
		ReplicaID:          replicaID,
		ExecutionAttemptID: attemptID,
		RuntimeID:          testLeaseRuntimeID,
		LeaseEpoch:         3,
		ErrorMessage:       "provider executable was not found",
	}); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("expected one cleanup request, got %d", requests)
	}
	permit, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if permit == nil || permit.Status != "completed" {
		t.Fatalf("start failure did not retire local permit: %#v", permit)
	}
}

func TestLocalRuntimeStartFailureSpoolRetriesWhenAPIUnavailable(t *testing.T) {
	const (
		attemptID = "55555555-5555-4555-8555-555555555555"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte(`{"code":"temporarily_unavailable"}`))
	}))
	defer server.Close()
	serverRuntime := &localRuntimeServer{
		options:   LocalRuntimeOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
		finalizer: &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()},
	}
	serverRuntime.finishProviderStartFailure(runtimeAttemptRef{
		attemptID:  attemptID,
		spaceID:    spaceID,
		replicaID:  replicaID,
		runtimeID:  testLeaseRuntimeID,
		leaseEpoch: 2,
		expiresAt:  time.Now().UTC().Add(time.Minute),
	}, "provider failed before startup")
	items, err := state.PendingSpool(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].EventID != "runtime-start-failed:"+attemptID {
		t.Fatalf("start failure spool was not retained: %#v", items)
	}
}

func TestDefaultProviderCommandsUseRuntimeHost(t *testing.T) {
	cases := map[string]string{
		"pi":          defaultRuntimeHostCommand,
		"codex":       defaultRuntimeHostCommand,
		"claude_code": defaultRuntimeHostCommand,
	}
	for provider, expected := range cases {
		if actual := defaultProviderCommand(provider); actual != expected {
			t.Fatalf("provider %q resolved to %q, want %q", provider, actual, expected)
		}
	}
	if command := defaultProviderCommand("unknown"); command != "" {
		t.Fatalf("unknown provider resolved to %q", command)
	}
}

func TestResolveRuntimeHostCommandUsesNodeForWindowsScripts(t *testing.T) {
	command, args, err := resolveRuntimeHostCommand(`C:\Program Files\Cohub\cohub-agent-runtime.js`, []string{"--provider", "pi"}, "windows", `C:\Program Files\nodejs\node.exe`)
	if err != nil {
		t.Fatal(err)
	}
	if command != `C:\Program Files\nodejs\node.exe` {
		t.Fatalf("command = %q, want node executable", command)
	}
	want := []string{`C:\Program Files\Cohub\cohub-agent-runtime.js`, "--provider", "pi"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestResolveRuntimeHostCommandLeavesNativeCommandsUntouched(t *testing.T) {
	command, args, err := resolveRuntimeHostCommand("cohub-agent-runtime", []string{"--provider", "pi"}, "windows", `C:\Program Files\nodejs\node.exe`)
	if err != nil {
		t.Fatal(err)
	}
	if command != "cohub-agent-runtime" || !reflect.DeepEqual(args, []string{"--provider", "pi"}) {
		t.Fatalf("native command was rewritten: command=%q args=%#v", command, args)
	}
}

func TestRunLocalRuntimeRequiresAuthoritativeAPI(t *testing.T) {
	err := RunLocalRuntime(context.Background(), LocalRuntimeOptions{
		RelayURL:        "wss://gateway.example/runtime/relay",
		RelayToken:      "token",
		RuntimeID:       "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		SpaceID:         "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		ReplicaID:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Provider:        "pi",
		ProviderCommand: "true",
		WorkspaceDir:    t.TempDir(),
		DataDir:         t.TempDir(),
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil || !strings.Contains(err.Error(), "API base URL is required") {
		t.Fatalf("expected fail-closed API URL validation, got %v", err)
	}
}

func localRuntimeReplicaFixture(root, replicaID, deviceID, status, appliedSnapshotID string) ReplicaState {
	return ReplicaState{
		SpaceID:           "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		ReplicaID:         replicaID,
		Root:              root,
		RootFingerprint:   "fingerprint",
		DeviceID:          deviceID,
		Status:            status,
		AppliedSnapshotID: appliedSnapshotID,
		UpdatedAt:         time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func TestWaitForLocalRuntimeReplicaWaitsForLocalSync(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	root := t.TempDir()
	const (
		replicaID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		deviceID  = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	)
	if err := state.UpsertReplica(localRuntimeReplicaFixture(root, replicaID, deviceID, "syncing", "")); err != nil {
		t.Fatal(err)
	}
	updated := make(chan struct{})
	go func() {
		defer close(updated)
		time.Sleep(120 * time.Millisecond)
		_ = state.SetReplicaApplied("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "snapshot-1", 1, "ready", []byte(`{"version":1}`))
	}()
	replica, err := waitForLocalRuntimeReplica(context.Background(), state, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", replicaID, deviceID, root, time.Second)
	<-updated
	if err != nil {
		t.Fatal(err)
	}
	if replica == nil || replica.Status != "ready" || replica.AppliedSnapshotID != "snapshot-1" {
		t.Fatalf("unexpected ready replica: %#v", replica)
	}
}

func TestWaitForLocalRuntimeReplicaRejectsIdentityMismatch(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	root := t.TempDir()
	if err := state.UpsertReplica(localRuntimeReplicaFixture(root, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "ready", "snapshot-1")); err != nil {
		t.Fatal(err)
	}
	_, err = waitForLocalRuntimeReplica(context.Background(), state, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "different-replica", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", root, time.Second)
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected replica identity mismatch, got %v", err)
	}
}

func TestWaitForLocalRuntimeReplicaRejectsTerminalState(t *testing.T) {
	for _, status := range []string{"conflicted", "detached", "error", "offline"} {
		t.Run(status, func(t *testing.T) {
			state, err := OpenState(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer state.Close()
			root := t.TempDir()
			if err := state.UpsertReplica(localRuntimeReplicaFixture(root, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status, "")); err != nil {
				t.Fatal(err)
			}
			_, err = waitForLocalRuntimeReplica(context.Background(), state, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", root, time.Second)
			if err == nil || !strings.Contains(err.Error(), status) {
				t.Fatalf("expected terminal status %q, got %v", status, err)
			}
		})
	}
}

func TestWaitForLocalRuntimeReplicaTimesOutWhileSyncing(t *testing.T) {
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	root := t.TempDir()
	if err := state.UpsertReplica(localRuntimeReplicaFixture(root, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "syncing", "")); err != nil {
		t.Fatal(err)
	}
	_, err = waitForLocalRuntimeReplica(context.Background(), state, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", root, 40*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("expected bounded readiness timeout, got %v", err)
	}
}

func TestStartAttemptLeaseHeartbeatPinsClaimedPermit(t *testing.T) {
	const (
		attemptID = "33333333-3333-4333-8333-333333333333"
		spaceID   = "11111111-1111-4111-8111-111111111111"
		replicaID = "22222222-2222-4222-8222-222222222222"
		baseID    = "44444444-4444-4444-8444-444444444444"
	)
	state, err := OpenState(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	expiresAt := time.Now().UTC().Add(time.Minute)
	if err := state.PutPermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, expiresAt, "local_agent", attemptID); err != nil {
		t.Fatal(err)
	}
	if err := state.ClaimLocalRuntimePermit(attemptID, spaceID, replicaID, testLeaseRuntimeID, baseID, 7, expiresAt); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/local-agent/spaces/"+spaceID+"/leases/heartbeat" {
			t.Fatalf("unexpected heartbeat path: %s", request.URL.Path)
		}
		requests++
		var body struct {
			HolderKind string `json:"holderKind"`
			HolderID   string `json:"holderId"`
			RuntimeID  string `json:"runtimeId"`
			Epoch      int64  `json:"epoch"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.HolderKind != "local_agent" || body.HolderID != attemptID || body.RuntimeID != testLeaseRuntimeID || body.Epoch != 7 {
			t.Fatalf("heartbeat identity is not pinned: %#v", body)
		}
		_, _ = writer.Write([]byte(fmt.Sprintf(`{"expiresAt":%q}`, time.Now().UTC().Add(2*time.Minute).Format(time.RFC3339Nano))))
	}))
	defer server.Close()
	daemon := &Daemon{cfg: Config{APIBaseURL: server.URL, AccessToken: "token"}, state: state, client: server.Client()}
	runtimeServer := &localRuntimeServer{finalizer: daemon}
	permit, err := state.PermitContext(attemptID)
	if err != nil || permit == nil {
		t.Fatalf("read claimed permit: %v %#v", err, permit)
	}
	hb, err := runtimeServer.startAttemptLeaseHeartbeat(context.Background(), runtimeAttemptRef{
		attemptID:      attemptID,
		spaceID:        spaceID,
		replicaID:      replicaID,
		runtimeID:      testLeaseRuntimeID,
		baseSnapshotID: baseID,
		leaseEpoch:     7,
		expiresAt:      expiresAt,
	}, permit)
	if err != nil {
		t.Fatal(err)
	}
	hb.stop()
	if requests != 1 {
		t.Fatalf("expected one initial server heartbeat, got %d", requests)
	}
	refreshed, err := state.PermitContext(attemptID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed == nil || !refreshed.ExpiresAt.After(expiresAt) || refreshed.Status != "active" {
		t.Fatalf("claimed permit was not renewed: %#v", refreshed)
	}
}

func TestRuntimeProcessEnvPinsRuntimeIdentity(t *testing.T) {
	t.Setenv("COHUB_RUNTIME_PROVIDER", "wrong")
	t.Setenv("COHUB_RUNTIME_CONNECTION_EPOCH", "stale")
	t.Setenv("COHUB_RUNTIME_EXECUTION_ATTEMPT_ID", "stale-attempt")
	t.Setenv("OPENAI_API_KEY", "preserve-openai-key")
	t.Setenv("ANTHROPIC_API_KEY", "preserve-anthropic-key")
	t.Setenv("COHUB_EXECUTION_TOKEN", "must-not-reach-provider")
	t.Setenv("COHUB_LOCAL_AGENT_ACCESS_TOKEN", "must-not-reach-provider")
	t.Setenv("COHUB_LOCAL_AGENT_REFRESH_TOKEN", "must-not-reach-provider")
	t.Setenv("COHUB_RELAY_TOKEN", "must-not-reach-provider")
	t.Setenv("COHUB_RUNTIME_TOKEN", "must-not-reach-provider")
	t.Setenv("COHUB_TOKEN", "must-not-reach-provider")
	env := runtimeProcessEnv(LocalRuntimeOptions{
		RuntimeID:          "runtime",
		SpaceID:            "space",
		ReplicaID:          "replica",
		Provider:           "codex",
		WorkspaceDir:       "/workspace/project",
		ConnectionEpoch:    17,
		ExecutionAttemptID: "attempt",
	})
	values := make(map[string]string, len(env))
	for _, item := range env {
		for _, key := range []string{"COHUB_RUNTIME_ID", "COHUB_SPACE_ID", "COHUB_RUNTIME_PROVIDER", "COHUB_RUNTIME_CWD", "COHUB_RUNTIME_CONNECTION_EPOCH", "COHUB_RUNTIME_EXECUTION_ATTEMPT_ID"} {
			if strings.HasPrefix(item, key+"=") {
				values[key] = strings.TrimPrefix(item, key+"=")
			}
		}
	}
	if values["COHUB_RUNTIME_PROVIDER"] != "codex" || values["COHUB_RUNTIME_ID"] != "runtime" || values["COHUB_RUNTIME_CWD"] != "/workspace/project" || values["COHUB_RUNTIME_CONNECTION_EPOCH"] != "17" || values["COHUB_RUNTIME_EXECUTION_ATTEMPT_ID"] != "attempt" {
		t.Fatalf("runtime identity was not pinned: %#v", values)
	}
	childValues := make(map[string]string, len(env))
	for _, item := range env {
		if key, value, ok := strings.Cut(item, "="); ok {
			childValues[key] = value
		}
	}
	if childValues["OPENAI_API_KEY"] != "preserve-openai-key" || childValues["ANTHROPIC_API_KEY"] != "preserve-anthropic-key" {
		t.Fatalf("provider credentials were not inherited: OPENAI_API_KEY=%q ANTHROPIC_API_KEY=%q", childValues["OPENAI_API_KEY"], childValues["ANTHROPIC_API_KEY"])
	}
	for _, key := range []string{
		"COHUB_ACCESS_TOKEN",
		"COHUB_EXECUTION_TOKEN",
		"COHUB_LOCAL_AGENT_ACCESS_TOKEN",
		"COHUB_LOCAL_AGENT_REFRESH_TOKEN",
		"COHUB_RELAY_TOKEN",
		"COHUB_RUNTIME_TOKEN",
		"COHUB_TOKEN",
	} {
		if _, present := childValues[key]; present {
			t.Fatalf("Cohub credential %s leaked into provider environment", key)
		}
	}
	for _, item := range runtimeProcessEnv(LocalRuntimeOptions{}) {
		if strings.HasPrefix(item, "COHUB_RUNTIME_CONNECTION_EPOCH=") || strings.HasPrefix(item, "COHUB_RUNTIME_EXECUTION_ATTEMPT_ID=") {
			t.Fatalf("unbound runtime inherited stale channel identity: %q", item)
		}
	}
}
