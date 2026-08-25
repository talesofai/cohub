import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  send(data: string) {
    this.sent.push(data);
  }

  fail(error: Error) {
    this.emit("error", error);
    this.finishClose(1006, "");
  }

  close(code = 1000, reason = "") {
    this.finishClose(code, reason);
  }

  terminate() {
    this.finishClose(1006, "");
  }

  private finishClose(code: number, reason: string) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }
}

mock.module("ws", { exports: { default: FakeWebSocket } });

const {
  disconnectSandboxWsClient,
  getSandboxClientConnection,
  startSandboxWsClient,
  waitForSandboxConnection,
} = await import("./ws-client.js");

function beginAttach(socket: FakeWebSocket, spaceId: string) {
  socket.open();
  socket.receive({
    version: "1",
    type: "sandbox.heartbeat",
    spaceId,
    sandboxId: "sandbox-test",
    timestamp: Date.now(),
    status: "ready",
  });
  const attachRequest = socket.sent
    .map((value) => JSON.parse(value) as { type: string; requestId: string })
    .find((message) => message.type === "session.attach");
  assert.ok(attachRequest);
  return attachRequest.requestId;
}

function finishAttach(socket: FakeWebSocket, spaceId: string, requestId: string, connectionId: string) {
  socket.receive({
    version: "1",
    type: "session.attach.ok",
    spaceId,
    sandboxId: "sandbox-test",
    timestamp: Date.now(),
    requestId,
    connectionId,
    identity: "agent-test",
  });
}

function attach(socket: FakeWebSocket, spaceId: string, connectionId: string) {
  finishAttach(socket, spaceId, beginAttach(socket, spaceId), connectionId);
}

test("a superseded connection attempt cannot replace the current connection", async () => {
  const spaceId = "space-stale-attach";
  FakeWebSocket.instances = [];

  try {
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://stale.test/sandbox",
      identity: "agent-test",
    });
    const staleSocket = FakeWebSocket.instances[0];
    assert.ok(staleSocket);
    const staleAttachRequestId = beginAttach(staleSocket, spaceId);

    disconnectSandboxWsClient(spaceId, "endpoint replaced");
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://ready.test/sandbox",
      identity: "agent-test",
    });
    const replacementSocket = FakeWebSocket.instances[1];
    assert.ok(replacementSocket);
    attach(replacementSocket, spaceId, "connection-current");
    const currentConnection = await waitForSandboxConnection(spaceId, 100);

    finishAttach(staleSocket, spaceId, staleAttachRequestId, "connection-stale");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(getSandboxClientConnection(spaceId), currentConnection);
    assert.equal(replacementSocket.readyState, FakeWebSocket.OPEN);
  } finally {
    disconnectSandboxWsClient(spaceId, "test cleanup");
    for (const socket of FakeWebSocket.instances) socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("disconnect and restart cannot revive a run loop waiting in reconnect backoff", async () => {
  const spaceId = "space-run-generation";
  FakeWebSocket.instances = [];

  let resolveConnectionError: (() => void) | undefined;
  const connectionError = new Promise<void>((resolve) => {
    resolveConnectionError = resolve;
  });

  try {
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://stale.test/sandbox",
      identity: "agent-test",
      hooks: {
        onConnectionError: () => resolveConnectionError?.(),
      },
    });
    const staleSocket = FakeWebSocket.instances[0];
    assert.ok(staleSocket);
    staleSocket.fail(new Error("connect ECONNREFUSED 10.0.0.1:8788"));
    await connectionError;
    await new Promise<void>((resolve) => setImmediate(resolve));

    disconnectSandboxWsClient(spaceId, "endpoint replaced");
    await startSandboxWsClient({
      spaceId,
      wsUrl: "ws://ready.test/sandbox",
      identity: "agent-test",
    });
    const replacementSocket = FakeWebSocket.instances[1];
    assert.ok(replacementSocket);
    attach(replacementSocket, spaceId, "connection-current");
    await waitForSandboxConnection(spaceId, 100);

    await delay(500);
    assert.equal(
      FakeWebSocket.instances.length,
      2,
      "the superseded run loop must not reconnect after its backoff finishes",
    );
  } finally {
    disconnectSandboxWsClient(spaceId, "test cleanup");
    for (const socket of FakeWebSocket.instances) socket.terminate();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});
