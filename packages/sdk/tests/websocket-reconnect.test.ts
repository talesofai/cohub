import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { MAX_REALTIME_ROOMS_PER_REQUEST } from "@cohub/protocol/realtime";
import { WebsocketClient, type WebSocketLike } from "../src/websocket.js";

type CloseSnapshot = { code: number; reason: string; willReconnect: boolean };

type AuthEnvelope = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.auth.ok";
  payload: { connectionId: string; user: Record<string, unknown> };
};

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason } as CloseEvent));
  }
}

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
};

const authOk = (connectionId: string): AuthEnvelope => ({
  id: `auth-${connectionId}`,
  timestamp: Date.now(),
  domain: "system",
  type: "system.auth.ok",
  payload: { connectionId, user: {} },
});

const authError = {
  id: "auth-error",
  timestamp: Date.now(),
  domain: "system",
  type: "system.request.error",
  payload: { code: "UNAUTHORIZED", message: "Unauthorized" },
};

const sentTypes = (socket: FakeWebSocket) =>
  socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

test("retries authentication with a forced token refresh and restores rooms", async () => {
  FakeWebSocket.instances = [];
  const tokenOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
  const closes: CloseSnapshot[] = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: (options) => {
      tokenOptions.push(options);
      return options?.forceRefresh ? "fresh-token" : null;
    },
    WebSocketImpl: FakeWebSocket,
  });
  client.on("close", (snapshot) => closes.push(snapshot));

  const release = client.subscribeSpace("space-1");
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();

  await waitFor(() => FakeWebSocket.instances.length === 2, "expected an auth reconnect");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected the refreshed auth request");
  second.receive(authOk("connection-2"));
  await waitFor(() => sentTypes(second).includes("subscribe"), "expected room restoration");

  assert.deepEqual(tokenOptions, [undefined, { forceRefresh: true }]);
  assert.deepEqual(closes.map(({ willReconnect }) => willReconnect), [true]);
  assert.equal(client.state, "open");

  release();
  await client.disconnect();
});

test("stops after a forced authentication retry is rejected", async () => {
  FakeWebSocket.instances = [];
  const tokenOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
  const closes: CloseSnapshot[] = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: (options) => {
      tokenOptions.push(options);
      return options?.forceRefresh ? "fresh-invalid-token" : "stale-token";
    },
    WebSocketImpl: FakeWebSocket,
  });
  client.on("close", (snapshot) => closes.push(snapshot));

  const release = client.subscribeSpace("space-1");
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected the initial auth request");
  first.receive(authError);

  await waitFor(() => FakeWebSocket.instances.length === 2, "expected one forced auth retry");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected the forced auth request");
  second.receive(authError);
  await waitFor(() => closes.length === 2, "expected the terminal auth close");
  await delay(5);

  assert.deepEqual(tokenOptions, [undefined, { forceRefresh: true }]);
  assert.deepEqual(closes.map(({ willReconnect }) => willReconnect), [true, false]);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.state, "closed");

  release();
  await client.disconnect();
});

test("batches room subscriptions and clears pending rooms after a request error", async () => {
  FakeWebSocket.instances = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    autoReconnect: false,
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });
  const rooms = Array.from(
    { length: MAX_REALTIME_ROOMS_PER_REQUEST + 2 },
    (_, index) => `session:session-${index}`,
  );
  const releaseRooms = client.subscribeRooms(rooms);
  assert.equal((client as unknown as { roomSubscriptions: Map<string, unknown> }).roomSubscriptions.size, rooms.length);
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  socket.open();
  await waitFor(() => sentTypes(socket).includes("auth"), "expected auth request");
  socket.receive(authOk("connection-batches"));

  const subscriptions = () => socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; requestId?: string; payload?: { rooms?: string[] } })
    .filter((event) => event.type === "subscribe");
  await waitFor(() => subscriptions().length === 1, "expected first subscription batch");
  const first = subscriptions()[0];
  assert.equal(first?.payload?.rooms?.length, MAX_REALTIME_ROOMS_PER_REQUEST);
  socket.receive({
    id: "subscribe-ok",
    timestamp: Date.now(),
    domain: "system",
    type: "system.subscribe.ok",
    requestId: first?.requestId,
    payload: { rooms: first?.payload?.rooms ?? [] },
  });

  await waitFor(() => subscriptions().length === 2, "expected second subscription batch");
  const second = subscriptions()[1];
  assert.equal(second?.payload?.rooms?.length, 2);
  socket.receive({
    id: "subscribe-error",
    timestamp: Date.now(),
    domain: "system",
    type: "system.request.error",
    requestId: second?.requestId,
    payload: { code: "BAD_REQUEST", message: "room limit" },
  });

  const releaseExtra = client.subscribeSpace("after-limit");
  await waitFor(() => subscriptions().length === 3, "expected failed rooms to become retryable");
  assert.deepEqual(subscriptions()[2]?.payload?.rooms, [
    ...rooms.slice(MAX_REALTIME_ROOMS_PER_REQUEST),
    "space:after-limit",
  ]);

  releaseExtra();
  releaseRooms();
  await client.disconnect();
});
