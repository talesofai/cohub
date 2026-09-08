package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type testRuntimeServer struct {
	binding chan json.RawMessage
}

func (s *testRuntimeServer) ServeChannel(_ context.Context, conn *websocket.Conn, _ string, binding json.RawMessage) {
	s.binding <- append(json.RawMessage(nil), binding...)
	_ = conn.Close(websocket.StatusNormalClosure, "done")
}

func TestWaitDataChannelsWaitsForOutstandingChannel(t *testing.T) {
	client := NewClient(Options{})
	release := make(chan struct{})
	started := make(chan struct{})
	client.dataWG.Add(1)
	go func() {
		defer client.dataWG.Done()
		close(started)
		<-release
	}()
	<-started

	done := make(chan struct{})
	go func() {
		client.WaitDataChannels()
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("WaitDataChannels returned before the data channel finished")
	case <-time.After(20 * time.Millisecond):
	}

	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("WaitDataChannels did not return after the data channel finished")
	}
}

func TestWriteControlSerializesConcurrentMessages(t *testing.T) {
	const messageCount = 64
	serverResult := make(chan error, 1)
	writeErrors := make(chan error, messageCount)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			serverResult <- err
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		seen := make(map[string]struct{}, messageCount)
		for index := 0; index < messageCount; index++ {
			typ, data, readErr := conn.Read(ctx)
			if readErr != nil {
				serverResult <- readErr
				return
			}
			if typ != websocket.MessageText {
				serverResult <- fmt.Errorf("control frame %d used message type %v", index, typ)
				return
			}
			var frame controlFrame
			if unmarshalErr := json.Unmarshal(data, &frame); unmarshalErr != nil {
				serverResult <- unmarshalErr
				return
			}
			seen[frame.Message] = struct{}{}
		}
		if len(seen) != messageCount {
			serverResult <- fmt.Errorf("received %d distinct control messages, want %d", len(seen), messageCount)
			return
		}
		serverResult <- nil
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")

	client := NewClient(Options{})
	var writers sync.WaitGroup
	for index := 0; index < messageCount; index++ {
		writers.Add(1)
		go func(index int) {
			defer writers.Done()
			if writeErr := client.writeControl(ctx, conn, controlFrame{Type: "event", Message: fmt.Sprintf("message-%d", index)}); writeErr != nil {
				writeErrors <- writeErr
			}
		}(index)
	}
	writers.Wait()
	close(writeErrors)
	for writeErr := range writeErrors {
		t.Fatal(writeErr)
	}
	select {
	case err := <-serverResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for control frames")
	}
}

func TestRuntimeRegistrationFrameCarriesConnectionIdentity(t *testing.T) {
	frame := runtimeRegistrationFrame(Options{
		SpaceID:   "space",
		ReplicaID: "replica",
		RuntimeID: "runtime",
		Provider:  "codex",
	}, "runtime")
	if frame.Type != "register" || frame.Kind != "runtime" {
		t.Fatalf("unexpected registration type: %#v", frame)
	}
	if frame.Protocol != runtimeWireProtocol {
		t.Fatalf("registration protocol = %q, want %q", frame.Protocol, runtimeWireProtocol)
	}
	if frame.SpaceID != "space" || frame.ReplicaID != "replica" || frame.RuntimeID != "runtime" || frame.Provider != "codex" {
		t.Fatalf("registration connection identity is incomplete: %#v", frame)
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"version", "protocolVersion", "deviceId"} {
		if strings.Contains(string(encoded), `"`+field+`"`) {
			t.Fatalf("redundant registration field %q leaked into %s", field, encoded)
		}
	}
}

func TestRuntimeDataChannelEchoesOpenBindingBeforeServing(t *testing.T) {
	binding := json.RawMessage(`{"executionAttemptId":"11111111-1111-4111-8111-111111111111","spaceId":"22222222-2222-4222-8222-222222222222","replicaId":"33333333-3333-4333-8333-333333333333","connectionEpoch":4,"baseSnapshotId":"44444444-4444-4444-8444-444444444444","leaseEpoch":7,"leaseExpiresAt":"2026-09-07T12:00:00.000Z"}`)
	serverResult := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			serverResult <- err
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var frame controlFrame
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			serverResult <- err
			return
		}
		if frame.Type != "open" || frame.Channel != "channel-1" || frame.Protocol != runtimeWireProtocol || !bytes.Equal(frame.Binding, binding) {
			serverResult <- fmt.Errorf("unexpected runtime open frame: %#v", frame)
			return
		}
		serverResult <- nil
	}))
	defer server.Close()

	runtimeServer := &testRuntimeServer{binding: make(chan json.RawMessage, 1)}
	client := NewClient(Options{
		RelayURL:      "ws" + strings.TrimPrefix(server.URL, "http") + "/runtime/relay",
		Token:         "token",
		Kind:          "runtime",
		RuntimeServer: runtimeServer,
		Logger:        slog.Default(),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client.openDataChannel(ctx, client.opts, "channel-1", runtimeWireProtocol, binding)

	select {
	case err := <-serverResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for runtime open frame")
	}
	select {
	case got := <-runtimeServer.binding:
		if !bytes.Equal(got, binding) {
			t.Fatalf("runtime server binding = %s, want %s", got, binding)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime server was not invoked")
	}
}
