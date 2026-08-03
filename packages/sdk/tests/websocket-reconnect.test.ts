import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
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

test("restores a pending room retained by multiple subscribers after reconnecting", async (t) => {
  FakeWebSocket.instances = [];
  const client = new WebsocketClient({
    url: "ws://localhost",
    reconnectBaseDelayMs: 0,
    reconnectMaxDelayMs: 0,
    getAccessToken: () => "token",
    WebSocketImpl: FakeWebSocket,
  });

  const releaseFirst = client.subscribeSpace("space-1");
  const releaseSecond = client.subscribeSpace("space-1");
  t.after(async () => {
    releaseFirst();
    releaseSecond();
    await client.disconnect();
  });
  const first = FakeWebSocket.instances[0];
  assert.ok(first);
  first.open();
  await waitFor(() => sentTypes(first).includes("auth"), "expected the initial auth request");
  first.receive(authOk("connection-1"));
  await waitFor(() => sentTypes(first).includes("subscribe"), "expected the initial room subscription");

  first.close(1012, "service restart");
  await waitFor(() => FakeWebSocket.instances.length === 2, "expected a reconnect");
  const second = FakeWebSocket.instances[1];
  assert.ok(second);
  second.open();
  await waitFor(() => sentTypes(second).includes("auth"), "expected the reconnect auth request");
  second.receive(authOk("connection-2"));
  await waitFor(
    () => sentTypes(second).includes("subscribe"),
    "expected the pending room subscription to be restored",
  );

  const subscribe = second.sent
    .map((raw) => JSON.parse(raw) as { type: string; payload?: unknown })
    .find((event) => event.type === "subscribe");
  assert.deepEqual(subscribe?.payload, { rooms: ["space:space-1"] });
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
