import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import type {
  LocalProviderAdapter,
  LocalRuntimeCapabilities,
  LocalRuntimeCommand,
  LocalRuntimeEvent,
  LocalRuntimePromptInput,
  LocalRuntimeSessionHandle,
} from "@cohub/protocol";
import { LocalRuntimeEventSchema } from "@cohub/protocol";
import { readLocalRuntimeFrames, runLocalRuntime } from "@cohub/local-runtime/runner";

const IDs = {
  runtimeId: "runtime-1",
  spaceId: "space-1",
  runtimeSessionId: "runtime-session-1",
  cohubSessionId: "cohub-session-1",
  executionAttemptId: "attempt-1",
  providerSessionId: "native-session-1",
};

const capabilities: LocalRuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  sessionFork: true,
  sessionCancel: true,
  permissionRequests: false,
  promptImages: true,
  nativeTools: true,
};

function command(overrides: Partial<LocalRuntimeCommand> = {}): LocalRuntimeCommand {
  return {
    version: 1,
    type: "command",
    commandId: "command-1",
    runtimeId: IDs.runtimeId,
    spaceId: IDs.spaceId,
    runtimeSessionId: IDs.runtimeSessionId,
    cohubSessionId: IDs.cohubSessionId,
    executionAttemptId: IDs.executionAttemptId,
    turnId: null,
    provider: "codex",
    providerSessionId: null,
    operation: "session.open",
    cwd: "/workspace",
    accessMode: "full_access",
    payload: {},
    connectionEpoch: 1,
    ...overrides,
  };
}

function openCommand(commandId = "open-1"): LocalRuntimeCommand {
  return command({ commandId, operation: "session.open", providerSessionId: null, turnId: null, payload: {} });
}

function turnCommand(commandId: string, turnId: string): LocalRuntimeCommand {
  return command({
    commandId,
    operation: "turn.start",
    providerSessionId: IDs.providerSessionId,
    turnId,
    payload: { text: "Inspect the workspace" },
  });
}

function turnCommandForSession(commandId: string, turnId: string, providerSessionId: string): LocalRuntimeCommand {
  return command({
    commandId,
    operation: "turn.start",
    providerSessionId,
    turnId,
    payload: { text: "Inspect the workspace" },
  });
}

function closeCommand(commandId = "close-1"): LocalRuntimeCommand {
  return command({ commandId, operation: "session.close", providerSessionId: IDs.providerSessionId, turnId: null, payload: {} });
}

function encode(...commands: LocalRuntimeCommand[]): string {
  return `${commands.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function collect(output: PassThrough): LocalRuntimeEvent[] {
  const events: LocalRuntimeEvent[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = LocalRuntimeEventSchema.parse(JSON.parse(line));
      events.push(parsed);
    }
  });
  return events;
}

class FixtureAdapter implements LocalProviderAdapter {
  readonly provider = "codex" as const;
  readonly version = "fixture";
  readonly capabilities = capabilities;
  openCalls: Array<{ cwd: string; providerSessionId: string | null | undefined }> = [];
  cancelCalls = 0;
  closeCalls = 0;
  waitForCancel = false;

  async open(input: { cwd: string; providerSessionId?: string | null; signal?: AbortSignal }): Promise<LocalRuntimeSessionHandle> {
    this.openCalls.push({ cwd: input.cwd, providerSessionId: input.providerSessionId });
    const adapter = this;
    return {
      providerSessionId: input.providerSessionId ?? IDs.providerSessionId,
      async *run(_prompt: LocalRuntimePromptInput, signal?: AbortSignal) {
        yield { kind: "text.delta", payload: { text: "done" }, providerEventId: "native-1" };
        if (adapter.waitForCancel) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield { kind: "turn.completed", payload: { stopReason: "end_turn" } };
      },
      async cancel() {
        adapter.cancelCalls += 1;
      },
      async close() {
        adapter.closeCalls += 1;
      },
    };
  }
}

class LazyCodexAdapter implements LocalProviderAdapter {
  readonly provider = "codex" as const;
  readonly version = "fixture-lazy-codex";
  readonly capabilities = capabilities;
  closeCalls = 0;

  async open(): Promise<LocalRuntimeSessionHandle> {
    const adapter = this;
    return {
      // Codex does not know the native thread id until its first stream event.
      providerSessionId: "",
      async *run() {
        yield {
          kind: "session.ready" as const,
          payload: { providerSessionId: "native-codex-thread" },
          providerEventId: "thread:native-codex-thread",
        };
        yield { kind: "text.delta" as const, payload: { text: "done" }, providerEventId: "text:1" };
        yield { kind: "turn.completed" as const, payload: { stopReason: "end_turn" } };
      },
      async cancel() {},
      async close() { adapter.closeCalls += 1; },
    };
  }
}

test("runs a native session and preserves per-session event ordering", async () => {
  const adapter = new FixtureAdapter();
  const input = Readable.from([encode(
    openCommand(),
    turnCommand("turn-1", "turn-1"),
  )]);
  const output = new PassThrough();
  const events = collect(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(adapter.openCalls.length, 1);
  assert.deepEqual(adapter.openCalls[0], { cwd: "/workspace", providerSessionId: null });
  assert.equal(adapter.closeCalls, 1);
  assert.deepEqual(events.map((event) => event.kind), ["session.ready", "turn.started", "text.delta", "turn.completed"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(events[2]?.providerEventId, "native-1");
  assert.equal(events[3]?.payload.stopReason, "end_turn");
});

test("allows a lazy Codex thread id to transition during the first turn", async () => {
  const adapter = new LazyCodexAdapter();
  const input = new PassThrough();
  const output = new PassThrough();
  const events = collect(output);
  const running = runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });
  input.write(`${JSON.stringify(openCommand("lazy-open"))}\n`);
  for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const provisionalId = events[0]?.providerSessionId;
  assert.ok(provisionalId?.startsWith("pending:"));
  if (!provisionalId) throw new Error("lazy Codex session did not receive a provisional id");
  input.write(`${JSON.stringify(turnCommandForSession("lazy-turn", "lazy-turn", provisionalId))}\n`);
  input.end();
  await running;

  assert.deepEqual(events.map((event) => event.kind), [
    "session.ready",
    "turn.started",
    "session.ready",
    "text.delta",
    "turn.completed",
  ]);
  assert.equal(events[2]?.providerSessionId, "native-codex-thread");
  assert.equal(events[2]?.payload.provisional, false);
  assert.equal(adapter.closeCalls, 1);
});

test("rejects a Codex resume command without a native provider session id", async () => {
  const adapter = new FixtureAdapter();
  const input = Readable.from([encode(command({
    commandId: "resume-without-id",
    operation: "session.resume",
    providerSessionId: null,
    turnId: null,
  }))]);
  const output = new PassThrough();
  const events = collect(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(adapter.openCalls.length, 0);
  assert.equal(events.length, 0);
});

test("cancels an active turn while the input loop remains responsive", async () => {
  const adapter = new FixtureAdapter();
  adapter.waitForCancel = true;
  const input = new PassThrough();
  const output = new PassThrough();
  const events = collect(output);
  const running = runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });
  input.write(`${JSON.stringify(openCommand())}\n`);
  input.write(`${JSON.stringify(turnCommand("turn-1", "turn-1"))}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  input.write(`${JSON.stringify(command({
    commandId: "cancel-1",
    operation: "turn.cancel",
    providerSessionId: IDs.providerSessionId,
    turnId: "turn-1",
    payload: { reason: "user stopped" },
  }))}\n`);
  input.write(`${JSON.stringify(closeCommand())}\n`);
  input.end();
  await running;

  assert.equal(adapter.cancelCalls, 1);
  assert.ok(events.some((event) => event.kind === "turn.failed" && event.payload.code === "cancelled"));
  assert.equal(events.at(-1)?.kind, "session.ready");
});

test("rejects a second turn without invoking the provider twice", async () => {
  const adapter = new FixtureAdapter();
  adapter.waitForCancel = true;
  const input = new PassThrough();
  const output = new PassThrough();
  const events = collect(output);
  const running = runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });
  input.write(`${JSON.stringify(openCommand())}\n`);
  input.write(`${JSON.stringify(turnCommand("turn-1", "turn-1"))}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  input.write(`${JSON.stringify(turnCommand("turn-2", "turn-2"))}\n`);
  input.write(`${JSON.stringify(command({ commandId: "cancel-1", operation: "turn.cancel", providerSessionId: IDs.providerSessionId, turnId: "turn-1" }))}\n`);
  input.end();
  await running;

  assert.equal(adapter.openCalls.length, 1);
  assert.ok(events.some((event) => event.turnId === "turn-2" && event.kind === "turn.failed" && event.payload.code === "concurrent_turn"));
});

test("enforces the input frame byte limit before parsing", async () => {
  const oversized = `${"x".repeat(32)}\n`;
  await assert.rejects(
    async () => {
      for await (const _frame of readLocalRuntimeFrames(Readable.from([oversized]), 16)) {
        // The first frame must be rejected before this body executes.
      }
    },
    /exceeds 16 bytes/,
  );
});
