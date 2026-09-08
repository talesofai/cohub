import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { LocalRuntimeProviderEvent } from "@cohub/protocol";
import {
  CodexAdapter,
  createCodexEventContext,
  mapCodexEvent,
} from "../providers/codex.js";

async function* eventsFrom(events: ThreadEvent[]) {
  for (const event of events) yield event;
}

test("maps cumulative Codex message snapshots to canonical deltas", () => {
  const context = createCodexEventContext("", "turn-1");
  assert.deepEqual(mapCodexEvent({ type: "thread.started", thread_id: "thread-1" }, context).map((event) => event.kind), ["session.ready"]);
  assert.equal(context.sessionId, "thread-1");
  assert.deepEqual(mapCodexEvent({ type: "item.started", item: { id: "msg-1", type: "agent_message", text: "Hello" } }, context).map((event) => event.kind), ["text.delta"]);
  const update = mapCodexEvent({ type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "Hello world" } }, context);
  assert.equal(update[0]?.kind, "text.delta");
  assert.equal(update[0]?.payload.text, " world");
  assert.notEqual(update[0]?.providerEventId, "msg-1");
  assert.deepEqual(mapCodexEvent({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "Hello world" } }, context), []);
});

test("hashes composite Codex event ids without truncating native ids", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const nativeId = "n".repeat(255);
  const [ready] = mapCodexEvent({ type: "thread.started", thread_id: nativeId }, context);
  assert.equal(ready?.kind, "session.ready");
  assert.ok((ready?.providerEventId?.length ?? 0) <= 255);
  assert.notEqual(ready?.providerEventId, `thread:${nativeId}`);
});

test("keeps Codex event ids within the UTF-8 byte limit", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const nativeId = "界".repeat(100);
  const [delta] = mapCodexEvent({
    type: "item.started",
    item: { id: nativeId, type: "agent_message", text: "hello" },
  }, context);
  assert.equal(delta?.kind, "text.delta");
  assert.ok((delta?.providerEventId ? Buffer.byteLength(delta.providerEventId, "utf8") : 0) <= 255);
});

test("drops Codex thread events with control characters", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const [ready] = mapCodexEvent({ type: "thread.started", thread_id: "thread-\n1" }, context);
  assert.equal(ready, undefined);
});

test("chunks oversized Codex text deltas below the runtime event limit", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const text = "x".repeat(3 * 1024 * 1024 + 17);
  const events = mapCodexEvent({
    type: "item.started",
    item: { id: "large-message", type: "agent_message", text },
  }, context);
  assert.ok(events.length > 1);
  assert.equal(events.every((event) => event.kind === "text.delta"), true);
  assert.equal(events.map((event) => String(event.payload.text)).join(""), text);
  assert.equal(new Set(events.map((event) => event.providerEventId)).size, events.length);
});

test("bounds Codex terminal and tool payloads", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const text = "\0".repeat(700 * 1024);
  mapCodexEvent({ type: "item.started", item: { id: "message", type: "agent_message", text } }, context);
  const terminal = mapCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
  }, context).at(-1);
  assert.equal(terminal?.kind, "turn.completed");
  assert.ok(Buffer.byteLength(JSON.stringify(terminal), "utf8") < 4 * 1024 * 1024);

  const toolEvents = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "tool-large",
      type: "mcp_tool_call",
      server: "server",
      tool: "tool",
      arguments: { input: text },
      result: { content: text },
      status: "completed",
    },
  } as unknown as ThreadEvent, context);
  assert.ok(toolEvents.length > 0);
  assert.ok(toolEvents.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") < 4 * 1024 * 1024));
});

test("maps command execution snapshots through a complete tool lifecycle", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const started = mapCodexEvent({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }, context);
  assert.deepEqual(started.map((event) => event.kind), ["tool.started"]);
  const updated = mapCodexEvent({ type: "item.updated", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "ok", status: "in_progress" } }, context);
  assert.deepEqual(updated.map((event) => event.kind), ["tool.updated"]);
  assert.equal(updated[0]?.payload.output, "ok");
  assert.notEqual(updated[0]?.providerEventId, started[0]?.providerEventId);
  const completed = mapCodexEvent({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm test", aggregated_output: "ok", status: "completed", exit_code: 0 } }, context);
  assert.deepEqual(completed.map((event) => event.kind), ["tool.completed"]);
});

test("keeps anonymous Codex item snapshots on one deterministic identity", () => {
  const context = createCodexEventContext("thread-1", "turn-anonymous");
  const started = mapCodexEvent({
    type: "item.started",
    item: { type: "command_execution", command: "printf hello", aggregated_output: "", status: "in_progress" },
  } as unknown as ThreadEvent, context);
  const updated = mapCodexEvent({
    type: "item.updated",
    item: { type: "command_execution", command: "printf hello", aggregated_output: "hello", status: "in_progress" },
  } as unknown as ThreadEvent, context);
  const completed = mapCodexEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "printf hello", aggregated_output: "hello", status: "completed", exit_code: 0 },
  } as unknown as ThreadEvent, context);
  assert.equal(started[0]?.payload.id, updated[0]?.payload.id);
  assert.equal(updated[0]?.payload.id, completed[0]?.payload.id);
  assert.match(String(started[0]?.payload.id), /^anonymous:/);
  assert.equal(started[0]?.providerEventId?.includes("random"), false);
});

test("preserves declined and newly introduced Codex item lifecycles", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const declined = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "cmd-declined",
      type: "command_execution",
      command: "rm -rf build",
      aggregated_output: "",
      status: "declined",
    },
  } as unknown as ThreadEvent, context);
  assert.equal(declined[0]?.kind, "tool.started");
  assert.equal(declined[1]?.kind, "tool.completed");
  assert.equal(declined[1]?.payload.isError, true);
  assert.notEqual(declined[0]?.providerEventId, declined[1]?.providerEventId);

  const collabStarted = mapCodexEvent({
    type: "item.started",
    item: { id: "collab-1", type: "collab_tool_call", tool: "spawn_agent", prompt: "inspect" },
  } as unknown as ThreadEvent, context);
  const collabCompleted = mapCodexEvent({
    type: "item.completed",
    item: { id: "collab-1", type: "collab_tool_call", tool: "spawn_agent", prompt: "inspect", status: "completed" },
  } as unknown as ThreadEvent, context);
  assert.equal(collabStarted[0]?.kind, "tool.started");
  assert.equal(collabStarted[0]?.payload.input && (collabStarted[0].payload.input as Record<string, unknown>).prompt, "inspect");
  assert.equal(collabCompleted[0]?.kind, "tool.completed");
});

test("keeps Codex ErrorItem warnings non-terminal", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const warning = mapCodexEvent({
    type: "item.completed",
    item: { id: "warning-1", type: "error", message: "configuration notice" },
  } as unknown as ThreadEvent, context);
  assert.deepEqual(warning, []);
  const completed = mapCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  }, context);
  const terminal = completed.at(-1);
  assert.equal(terminal?.kind, "turn.completed");
  assert.deepEqual((terminal?.payload.metadata as Record<string, unknown> | undefined)?.warnings, ["configuration notice"]);
});

test("keeps transient Codex stream errors non-terminal", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  assert.deepEqual(mapCodexEvent({ type: "error", message: "Reconnecting... 2/5" } as ThreadEvent, context), []);
  assert.deepEqual(mapCodexEvent({ type: "error", message: "Reconnecting... 3/5" } as ThreadEvent, context), []);
  assert.deepEqual(mapCodexEvent({ type: "error", message: "Reconnecting... waiting for network" } as ThreadEvent, context), []);
  const completed = mapCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  }, context);
  const terminal = completed.at(-1);
  assert.equal(terminal?.kind, "turn.completed");
  assert.deepEqual((terminal?.payload.metadata as Record<string, unknown> | undefined)?.warnings, [
    "Reconnecting... 2/5",
    "Reconnecting... 3/5",
    "Reconnecting... waiting for network",
  ]);
});

test("fails the turn for non-retryable Codex stream errors", () => {
  const context = createCodexEventContext("thread-1", "turn-1");
  const [failure] = mapCodexEvent({ type: "error", message: "authentication failed" } as ThreadEvent, context);
  assert.equal(failure?.kind, "turn.failed");
  assert.equal(failure?.payload.message, "authentication failed");
  assert.equal(failure?.payload.code, "provider_stream_error");
  assert.equal(failure?.payload.unknownOutcome, true);
  assert.equal(failure?.payload.retryable, false);
});

test("opens and resumes native Codex threads through the SDK seam", async () => {
  let receivedOptions: ThreadOptions | undefined;
  let resumedId = "";
  const thread = {
    id: "prior-thread",
    async runStreamed() {
      return {
        events: eventsFrom([
          { type: "thread.started", thread_id: "prior-thread" },
          { type: "turn.started" },
          { type: "item.started", item: { id: "msg-1", type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: { input_tokens: 4, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } },
        ] as ThreadEvent[]),
      };
    },
  };
  const client = {
    startThread(options?: ThreadOptions) {
      receivedOptions = options;
      return thread;
    },
    resumeThread(id: string, options?: ThreadOptions) {
      resumedId = id;
      receivedOptions = options;
      return thread;
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => client });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "prior-thread" });
  assert.equal(resumedId, "prior-thread");
  assert.equal(receivedOptions?.workingDirectory, "/workspace");
  assert.equal(receivedOptions?.sandboxMode, "read-only");
  assert.equal(receivedOptions?.skipGitRepoCheck, true);
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "hello" })) output.push(event);
  assert.deepEqual(output.map((event) => event.kind), ["turn.started", "session.ready", "turn.started", "text.delta", "usage", "turn.completed"]);
  assert.equal(output.find((event) => event.kind === "text.delta")?.payload.text, "done");
  assert.equal(output.at(-1)?.payload.stopReason, "end_turn");
  await handle.close();
});

test("forwards an explicit Codex executable override to the SDK", async () => {
  let receivedCodexOptions: { codexPathOverride?: string } | undefined;
  const thread = {
    id: "thread-override",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({
    codex: { codexPathOverride: "/opt/codex/bin/codex" },
    clientFactory: (options) => {
      receivedCodexOptions = options;
      return { startThread: () => thread, resumeThread: () => thread };
    },
  });
  const handle = await adapter.open({ cwd: "/workspace" });
  assert.equal(receivedCodexOptions?.codexPathOverride, "/opt/codex/bin/codex");
  await handle.close();
});

test("allows an explicit Codex Git repository preflight", async () => {
  let receivedOptions: ThreadOptions | undefined;
  const thread = {
    id: "thread-1",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({
    skipGitRepoCheck: false,
    clientFactory: () => ({
      startThread(options?: ThreadOptions) { receivedOptions = options; return thread; },
      resumeThread(_id: string, options?: ThreadOptions) { receivedOptions = options; return thread; },
    }),
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  assert.equal(receivedOptions?.skipGitRepoCheck, false);
  await handle.close();
});

test("enforces Codex session operation invariants before creating a thread", async () => {
  const adapter = new CodexAdapter({
    clientFactory: () => {
      throw new Error("client must not be created for invalid session operations");
    },
  });
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace", operation: "session.resume", providerSessionId: null }),
    /session\.resume requires a providerSessionId/,
  );
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace", operation: "session.open", providerSessionId: "thread-1" }),
    /session\.open must not include a providerSessionId/,
  );
});

test("rejects oversized or unsafe Codex resume ids before invoking the SDK", async () => {
  let calls = 0;
  const adapter = new CodexAdapter({
    clientFactory: () => {
      calls += 1;
      throw new Error("client must not be created for invalid session ids");
    },
  });
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace", providerSessionId: "界".repeat(86) }),
    /session id exceeds the size limit/,
  );
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace", providerSessionId: "thread-\n1" }),
    /session id contains control characters/,
  );
  assert.equal(calls, 0);
});

test("reads Codex thread settings from local adapter configuration", async () => {
  let receivedOptions: ThreadOptions | undefined;
  const thread = {
    id: "thread-payload-only",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({
    modelReasoningEffort: "high",
    clientFactory: () => ({
      startThread(options?: ThreadOptions) { receivedOptions = options; return thread; },
      resumeThread(_id: string, options?: ThreadOptions) { receivedOptions = options; return thread; },
    }),
  });
  const handle = await adapter.open({ cwd: "/workspace" });
  assert.equal(receivedOptions?.modelReasoningEffort, "high");
  await handle.close();
});

test("rejects unsupported Codex model reasoning effort values", async () => {
  const adapter = new CodexAdapter({
    modelReasoningEffort: "unbounded" as never,
    clientFactory: () => {
      throw new Error("client must not be created for invalid reasoning effort");
    },
  });
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace" }),
    /modelReasoningEffort is invalid/,
  );
});

test("derives Codex sandbox and approval policy from the authorized access mode", async () => {
  const received: ThreadOptions[] = [];
  const thread = {
    id: "thread-1",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const client = {
    startThread(options?: ThreadOptions) { if (options) received.push(options); return thread; },
    resumeThread(_id: string, options?: ThreadOptions) { if (options) received.push(options); return thread; },
  };
  const adapter = new CodexAdapter({ clientFactory: () => client });
  const readOnly = await adapter.open({
    cwd: "/workspace",
    accessMode: "read_only",
  });
  const fullAccess = await adapter.open({
    cwd: "/workspace",
    accessMode: "full_access",
  });
  assert.equal(received[0]?.sandboxMode, "read-only");
  assert.equal(received[0]?.approvalPolicy, "never");
  assert.equal(received[0]?.networkAccessEnabled, false);
  assert.equal(received[0]?.webSearchMode, "disabled");
  assert.equal(received[0]?.webSearchEnabled, false);
  assert.equal(received[1]?.sandboxMode, "workspace-write");
  assert.equal(received[1]?.approvalPolicy, "never");
  await readOnly.close();
  await fullAccess.close();
});

test("does not allow read-only Codex sessions to inherit network or search access", async () => {
  let receivedOptions: ThreadOptions | undefined;
  const thread = {
    id: "thread-read-only-network",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({
    networkAccessEnabled: true,
    webSearchMode: "live",
    webSearchEnabled: true,
    clientFactory: () => ({
      startThread(options?: ThreadOptions) { receivedOptions = options; return thread; },
      resumeThread(_id: string, options?: ThreadOptions) { receivedOptions = options; return thread; },
    }),
  });
  const handle = await adapter.open({
    cwd: "/workspace",
    accessMode: "read_only",
  });
  assert.equal(receivedOptions?.networkAccessEnabled, false);
  assert.equal(receivedOptions?.webSearchMode, "disabled");
  assert.equal(receivedOptions?.webSearchEnabled, false);
  await handle.close();
});

test("exposes a null native id until a new Codex thread starts", async () => {
  let threadId: string | null = null;
  const thread = {
    get id() {
      return threadId;
    },
    async runStreamed() {
      return { events: eventsFrom([{ type: "thread.started", thread_id: "created-thread" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  assert.equal(handle.providerSessionId, "");
  threadId = "created-thread";
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "hello" })) output.push(event);
  assert.equal(output.find((event) => event.kind === "session.ready")?.payload.providerSessionId, "created-thread");
  assert.equal(handle.providerSessionId, "created-thread");
  await handle.close();
});

test("fails closed when a new Codex stream omits thread.started", async () => {
  const thread = {
    id: null,
    async runStreamed() {
      return {
        events: eventsFrom([
          { type: "turn.started" },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        ] as ThreadEvent[]),
      };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "hello" })) output.push(event);
  const failure = output.at(-1);
  assert.equal(failure?.kind, "turn.failed");
  assert.equal(failure?.payload.unknownOutcome, true);
  assert.match(String(failure?.payload.message), /thread\.started/);
  assert.equal(output.some((event) => event.kind === "turn.completed"), false);
  await handle.close();
});

test("propagates cancellation as an aborted canonical failure", async () => {
  const thread = {
    id: "thread-1",
    async runStreamed(_input: unknown, options?: { signal?: AbortSignal }) {
      return {
        events: (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted")), { once: true });
          });
        })(),
      };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1" });
  const output: LocalRuntimeProviderEvent[] = [];
  const running = (async () => {
    for await (const event of handle.run({ text: "wait" })) output.push(event);
  })();
  await new Promise((resolve) => setImmediate(resolve));
  await handle.cancel("cancelled by test");
  await running;
  const failure = output.find((event) => event.kind === "turn.failed");
  assert.equal(failure?.payload.aborted, true);
  await handle.close();
});

test("combines session and per-turn cancellation signals", async () => {
  const sessionAbort = new AbortController();
  const turnAbort = new AbortController();
  const thread = {
    id: "thread-1",
    async runStreamed(_input: unknown, options?: { signal?: AbortSignal }) {
      return {
        events: (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        })(),
      };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1", signal: sessionAbort.signal });
  const output: LocalRuntimeProviderEvent[] = [];
  const running = (async () => {
    for await (const event of handle.run({ text: "wait" }, turnAbort.signal)) output.push(event);
  })();
  await new Promise((resolve) => setImmediate(resolve));
  sessionAbort.abort(new Error("runtime stopped"));
  await running;
  const failure = output.find((event) => event.kind === "turn.failed");
  assert.equal(failure?.payload.aborted, true);
  await handle.close();
});

test("marks an interrupted Codex stream as an unknown outcome", async () => {
  const thread = {
    id: "thread-1",
    async runStreamed() {
      return {
        events: eventsFrom([
          { type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "touch result", aggregated_output: "", status: "in_progress" } },
        ] as ThreadEvent[]),
      };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1" });
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "run" })) output.push(event);
  const failure = output.find((event) => event.kind === "turn.failed");
  assert.equal(failure?.payload.unknownOutcome, true);
  assert.equal(failure?.payload.retryable, false);
  await handle.close();
});

test("fences provider-supplied Codex image paths to the session workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-path-test-"));
  const inside = join(root, "inside.png");
  const outside = join(root, "..", `outside-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  await Promise.all([writeFile(inside, Buffer.from("not-an-image")), writeFile(outside, Buffer.from("not-an-image"))]);
  try {
    let receivedInput: unknown;
    const thread = {
      id: "thread-1",
      async runStreamed(input: unknown) {
        receivedInput = input;
        return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
      },
    };
    const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
    const handle = await adapter.open({ cwd: root, providerSessionId: "thread-1" });
    const accepted: LocalRuntimeProviderEvent[] = [];
    for await (const event of handle.run({ text: "inspect", options: { images: [{ path: "inside.png" }] } })) accepted.push(event);
    assert.equal(accepted.at(-1)?.kind, "turn.completed");
    assert.deepEqual(receivedInput, [{ type: "text", text: "inspect" }, { type: "local_image", path: inside }]);

    const rejected: LocalRuntimeProviderEvent[] = [];
    for await (const event of handle.run({ text: "inspect", options: { images: [{ path: outside }] } })) rejected.push(event);
    assert.equal(rejected.at(-1)?.kind, "turn.failed");
    assert.match(String(rejected.at(-1)?.payload.message), /outside the authorized workspace/);
    await handle.close();
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { force: true })]);
  }
});

test("resolves Codex virtual image paths from the workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-workspace-root-"));
  const cwd = join(root, "nested");
  const image = join(root, "root.png");
  await mkdir(cwd, { recursive: true });
  await writeFile(image, Buffer.from("not-an-image"));
  try {
    const received: unknown[] = [];
    const thread = {
      id: "thread-workspace-root",
      async runStreamed(input: unknown) {
        received.push(input);
        return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0 } }] as ThreadEvent[]) };
      },
    };
    const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
    const handle = await adapter.open({ cwd, workspaceRoot: root, providerSessionId: "thread-workspace-root" });
    for (const path of ["/workspace/root.png", "@/workspace/root.png", "file:///workspace/root.png"]) {
      const output: LocalRuntimeProviderEvent[] = [];
      for await (const event of handle.run({ text: "inspect", options: { images: [{ path }] } })) output.push(event);
      assert.equal(output.at(-1)?.kind, "turn.completed");
    }
    assert.deepEqual(received.map((input) => (input as Array<{ path?: string }>)[1]?.path), [image, image, image]);
    await handle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a Codex cwd outside an explicit workspace root", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cohub-codex-workspace-fence-"));
  const outside = await mkdtemp(join(tmpdir(), "cohub-codex-workspace-outside-"));
  let clientCreated = false;
  try {
    const adapter = new CodexAdapter({
      clientFactory: () => {
        clientCreated = true;
        throw new Error("Codex client must not be created");
      },
    });
    await assert.rejects(
      () => adapter.open({ cwd: outside, workspaceRoot, providerSessionId: "thread-outside" }),
      /Codex provider cwd must stay inside the workspace/,
    );
    assert.equal(clientCreated, false);
  } finally {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("rejects unsafe native Codex ids returned by startThread", async () => {
  const unsafeThread = {
    id: "thread-\nunsafe",
    async runStreamed() {
      return { events: eventsFrom([] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => unsafeThread, resumeThread: () => unsafeThread }) });
  await assert.rejects(
    () => adapter.open({ cwd: "/workspace", providerSessionId: null }),
    /provider session id contains control characters/,
  );
});

test("rejects non-image Codex data URLs", async () => {
  const thread = {
    id: "thread-1",
    async runStreamed() {
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1" });
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "inspect", options: { images: ["data:text/plain;base64,SGVsbG8="] } })) output.push(event);
  assert.equal(output.at(-1)?.kind, "turn.failed");
  assert.match(String(output.at(-1)?.payload.message), /MIME type must be an image/);
  await handle.close();
});

test("rejects malformed Codex prompt blocks instead of dropping them", async () => {
  let calls = 0;
  const thread = {
    id: "thread-1",
    async runStreamed() {
      calls += 1;
      return { events: eventsFrom([{ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0 } }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1" });
  const output: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "inspect", content: [{ type: "unsupported" } as never] })) output.push(event);
  assert.equal(output.at(-1)?.kind, "turn.failed");
  assert.match(String(output.at(-1)?.payload.message), /unsupported/);
  assert.equal(calls, 0);
  await handle.close();
});

test("aborts Codex when a consumer closes an active iterator early", async () => {
  let nativeSignal: AbortSignal | undefined;
  const thread = {
    id: "thread-1",
    async runStreamed(_input: unknown, options?: { signal?: AbortSignal }) {
      nativeSignal = options?.signal;
      return { events: eventsFrom([{ type: "turn.started" }] as ThreadEvent[]) };
    },
  };
  const adapter = new CodexAdapter({ clientFactory: () => ({ startThread: () => thread, resumeThread: () => thread }) });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: "thread-1" });
  const iterator = handle.run({ text: "inspect" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");
  // Advance past the adapter's initial lifecycle marker so the native
  // stream has been started before closing the consumer.
  await iterator.next();
  await iterator.return?.();
  assert.equal(nativeSignal?.aborted, true);
  await handle.close();
});
