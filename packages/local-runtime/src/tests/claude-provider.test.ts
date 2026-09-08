import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options as ClaudeOptions, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LocalRuntimeProviderEvent } from "@cohub/protocol";
import {
  ClaudeAdapter,
  createClaudeEventContext,
  mapClaudeMessage,
} from "../providers/claude.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

const sdk = (value: unknown) => value as SDKMessage;

test("maps Claude partial text without duplicating the complete assistant block", () => {
  const context = createClaudeEventContext(sessionId, "turn-1");
  assert.deepEqual(mapClaudeMessage(sdk({
    type: "stream_event",
    event: { type: "message_start", message: { id: "message-1" } },
    uuid: "event-1",
    session_id: sessionId,
    parent_tool_use_id: null,
  }), context), []);
  const delta = mapClaudeMessage(sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    uuid: "event-2",
    session_id: sessionId,
    parent_tool_use_id: null,
  }), context);
  assert.equal(delta[0]?.kind, "text.delta");
  assert.equal(delta[0]?.payload.text, "Hello");
  const complete = mapClaudeMessage(sdk({
    type: "assistant",
    message: { id: "message-1", content: [{ type: "text", text: "Hello" }] },
    parent_tool_use_id: null,
    uuid: "event-3",
    session_id: sessionId,
  }), context);
  assert.deepEqual(complete, []);
});

test("maps Claude init to session readiness and preserves the native id", () => {
  const context = createClaudeEventContext(sessionId, "turn-init");
  const events = mapClaudeMessage(sdk({
    type: "system",
    subtype: "init",
    uuid: "event-init-ready",
    session_id: sessionId,
  }), context);
  assert.deepEqual(events.map((event) => event.kind), ["session.ready"]);
  assert.equal(events[0]?.payload.providerSessionId, sessionId);
});

test("does not expose subagent text unless explicitly enabled", () => {
  const hidden = createClaudeEventContext(sessionId, "turn-subagent-hidden");
  const hiddenEvents = mapClaudeMessage(sdk({
    type: "assistant",
    parent_tool_use_id: "task-1",
    message: { id: "subagent-message", content: [{ type: "text", text: "internal progress" }] },
    uuid: "event-subagent-hidden",
    session_id: sessionId,
  }), hidden);
  assert.deepEqual(hiddenEvents, []);

  const forwarded = createClaudeEventContext(sessionId, "turn-subagent-forwarded", null, true);
  const forwardedEvents = mapClaudeMessage(sdk({
    type: "assistant",
    parent_tool_use_id: "task-1",
    message: { id: "subagent-message", content: [{ type: "text", text: "visible progress" }] },
    uuid: "event-subagent-forwarded",
    session_id: sessionId,
  }), forwarded);
  assert.deepEqual(forwardedEvents.map((event) => event.kind), ["text.delta"]);
  assert.equal(forwardedEvents[0]?.payload.text, "visible progress");
});

test("correlates task notifications by task id when no tool-use id is present", () => {
  const context = createClaudeEventContext(sessionId, "turn-task");
  const started = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_started",
    task_id: "task-1",
    uuid: "event-task-start",
    session_id: sessionId,
  }), context);
  assert.deepEqual(started.map((event) => event.kind), ["tool.started"]);
  const completed = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    status: "completed",
    summary: "finished",
    uuid: "event-task-done",
    session_id: sessionId,
  }), context);
  assert.deepEqual(completed.map((event) => event.kind), ["tool.completed"]);
  assert.equal(completed[0]?.payload.id, "task-1");
});

test("maps terminal Claude task updates and replaces them with the final notification", () => {
  const context = createClaudeEventContext(sessionId, "turn-task-updated");
  const started = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_started",
    task_id: "task-native",
    tool_use_id: "tool-native",
    subagent_type: "Explore",
    uuid: "event-task-updated-start",
    session_id: sessionId,
  }), context);
  assert.deepEqual(started.map((event) => event.kind), ["tool.started"]);
  assert.equal(started[0]?.payload.id, "tool-native");

  const running = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_updated",
    task_id: "task-native",
    patch: { status: "running", description: "searching" },
    uuid: "event-task-updated-running",
    session_id: sessionId,
  }), context);
  assert.deepEqual(running.map((event) => event.kind), ["tool.updated"]);
  assert.equal(running[0]?.payload.id, "tool-native");

  const terminal = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_updated",
    task_id: "task-native",
    patch: { status: "failed", error: "worker stopped" },
    uuid: "event-task-updated-terminal",
    session_id: sessionId,
  }), context);
  assert.deepEqual(terminal.map((event) => event.kind), ["tool.completed"]);
  assert.equal(terminal[0]?.payload.id, "tool-native");
  assert.equal(terminal[0]?.payload.status, "failed");
  assert.equal(terminal[0]?.payload.isError, true);
  assert.equal(terminal[0]?.payload.output, "worker stopped");

  const toolResult = mapClaudeMessage(sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-native", content: "final tool output", is_error: true }] },
    uuid: "event-task-updated-tool-result",
    session_id: sessionId,
  }), context);
  assert.deepEqual(toolResult.map((event) => event.kind), ["tool.completed"]);
  assert.equal(toolResult[0]?.payload.output, "final tool output");

  const notification = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_notification",
    task_id: "task-native",
    tool_use_id: "tool-native",
    status: "failed",
    summary: "worker stopped after the final retry",
    output_file: "task-output.txt",
    uuid: "event-task-updated-notification",
    session_id: sessionId,
  }), context);
  assert.deepEqual(notification.map((event) => event.kind), ["tool.completed"]);
  assert.equal(notification[0]?.payload.output, "worker stopped after the final retry");

  const replay = mapClaudeMessage(sdk({
    type: "system",
    subtype: "task_notification",
    task_id: "task-native",
    tool_use_id: "tool-native",
    status: "failed",
    summary: "worker stopped after the final retry",
    output_file: "task-output.txt",
    uuid: "event-task-updated-notification-replay",
    session_id: sessionId,
  }), context);
  assert.deepEqual(replay, []);
});

test("does not reinterpret an outside Claude image path as bare base64", async () => {
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-image-path-init", session_id: nativeSessionId });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const events: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "inspect", options: { images: ["/etc/passwd"] } })) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(String(events.at(-1)?.payload.message), /outside the authorized workspace/);
  await handle.close();
});

test("rejects remote Claude image URLs before the native SDK can fetch them", async () => {
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-image-url-init", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "read_only" });
  const events: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "inspect", options: { images: ["https://example.com/image.png"] } })) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(String(events.at(-1)?.payload.message), /remote image URLs are not supported/);
  await handle.close();
});

test("rejects malformed Claude prompt options", async () => {
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-options-init", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const events: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "inspect", options: [] as unknown as Record<string, unknown> })) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(String(events.at(-1)?.payload.message), /options must be an object/);
  await handle.close();
});

test("deduplicates partial text by content when assistant frames share an id", () => {
  const context = createClaudeEventContext(sessionId, "turn-shared-message");
  mapClaudeMessage(sdk({
    type: "stream_event",
    event: { type: "message_start", message: { id: "message-shared" } },
    uuid: "event-shared-start",
    session_id: sessionId,
  }), context);
  const streamed = mapClaudeMessage(sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } },
    uuid: "event-shared-delta",
    session_id: sessionId,
  }), context);
  assert.equal(streamed[0]?.payload.text, "first");
  const firstComplete = mapClaudeMessage(sdk({
    type: "assistant",
    message: { id: "message-shared", content: [{ type: "text", text: "first" }] },
    uuid: "event-shared-first",
    session_id: sessionId,
  }), context);
  assert.deepEqual(firstComplete, []);
  const secondComplete = mapClaudeMessage(sdk({
    type: "assistant",
    message: { id: "message-shared", content: [{ type: "text", text: "second" }] },
    uuid: "event-shared-second",
    session_id: sessionId,
  }), context);
  assert.equal(secondComplete[0]?.payload.text, "second");
  assert.notEqual(secondComplete[0]?.payload.itemId, streamed[0]?.payload.itemId);
});

test("maps Claude tool calls, results, usage, and turn completion", () => {
  const context = createClaudeEventContext(sessionId, "turn-2");
  const started = mapClaudeMessage(sdk({
    type: "assistant",
    message: { id: "message-2", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "a.txt" } }] },
    parent_tool_use_id: null,
    uuid: "event-4",
    session_id: sessionId,
  }), context);
  assert.deepEqual(started.map((event) => event.kind), ["tool.started"]);
  const completed = mapClaudeMessage(sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] },
    parent_tool_use_id: null,
    uuid: "event-5",
    session_id: sessionId,
  }), context);
  assert.deepEqual(completed.map((event) => event.kind), ["tool.completed"]);
  const terminal = mapClaudeMessage(sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
    total_cost_usd: 0.01,
    permission_denials: [],
    uuid: "event-6",
    session_id: sessionId,
  }), context);
  assert.deepEqual(terminal.map((event) => event.kind), ["usage", "turn.completed"]);
  const usagePayload = terminal.at(0)?.payload.usage as { input?: number } | undefined;
  assert.equal(usagePayload?.input, 3);
  assert.equal(terminal.at(-1)?.payload.output, "done");
});

test("ignores replayed Claude user tool results", () => {
  const context = createClaudeEventContext(sessionId, "turn-replay-user");
  const events = mapClaudeMessage(sdk({
    type: "user",
    isReplay: true,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "old-tool", content: "old output" }],
    },
    parent_tool_use_id: null,
    uuid: "event-replay-user",
    session_id: sessionId,
  }), context);
  assert.deepEqual(events, []);
  assert.equal(context.tools.has("old-tool"), false);
});

test("preserves native permission denial reasons", () => {
  const context = createClaudeEventContext(sessionId, "turn-permission-denied");
  const events = mapClaudeMessage(sdk({
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "denied-tool",
    message: "The command was blocked by policy",
    decision_reason: "policy",
    uuid: "event-permission-denied",
    session_id: sessionId,
  }), context);
  assert.equal(events[0]?.kind, "tool.completed");
  assert.equal(events[0]?.payload.output, "The command was blocked by policy");
});

test("keeps provider event ids unique when one native message yields multiple events", () => {
  const context = createClaudeEventContext(sessionId, "turn-ids");
  const assistantEvents = mapClaudeMessage(sdk({
    type: "assistant",
    message: {
      id: "message-many",
      content: [
        { type: "tool_use", id: "tool-a", name: "Read", input: { path: "a.txt" } },
        { type: "tool_use", id: "tool-b", name: "Read", input: { path: "b.txt" } },
      ],
    },
    parent_tool_use_id: null,
    uuid: "event-many",
    session_id: sessionId,
  }), context);
  assert.deepEqual(assistantEvents.map((event) => event.kind), ["tool.started", "tool.started"]);
  assert.equal(new Set(assistantEvents.map((event) => event.providerEventId)).size, assistantEvents.length);

  const resultEvents = mapClaudeMessage(sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    usage: { input_tokens: 2, output_tokens: 1 },
    total_cost_usd: 0.02,
    permission_denials: [
      { tool_use_id: "tool-c", tool_name: "Bash", tool_input: { command: "one" } },
      { tool_use_id: "tool-d", tool_name: "Bash", tool_input: { command: "two" } },
    ],
    uuid: "event-result-many",
    session_id: sessionId,
  }), context);
  assert.deepEqual(resultEvents.map((event) => event.kind), ["usage", "tool.completed", "tool.completed", "turn.completed"]);
  assert.equal(new Set(resultEvents.map((event) => event.providerEventId)).size, resultEvents.length);
});

test("opens a persistent native Claude query with native settings and credentials", async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const adapter = new ClaudeAdapter(({ options }) => {
    receivedOptions = options as Record<string, unknown>;
    const nativeSessionId = String(options?.sessionId || "");
    const messages: SDKMessage[] = [
      sdk({ type: "system", subtype: "init", uuid: "event-init", session_id: nativeSessionId }),
      sdk({ type: "assistant", message: { id: "message-3", content: [{ type: "text", text: "ok" }] }, parent_tool_use_id: null, uuid: "event-assistant", session_id: nativeSessionId }),
      sdk({ type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], uuid: "event-result", session_id: nativeSessionId }),
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({
    cwd: "/workspace",
    providerSessionId: null,
    model: "claude-sonnet",
    accessMode: "read_only",
  } as never);
  const output = [];
  for await (const event of handle.run({ text: "hello" })) output.push(event);
  assert.deepEqual(output.map((event) => event.kind), ["turn.started", "session.ready", "text.delta", "usage", "turn.completed"]);
  assert.equal(receivedOptions?.settingSources, undefined);
  assert.equal(receivedOptions?.persistSession, true);
  assert.equal(receivedOptions?.resume, undefined);
  assert.equal(typeof receivedOptions?.sessionId, "string");
  assert.equal(receivedOptions?.cwd, "/workspace");
  assert.equal(typeof receivedOptions?.env, "object");
  assert.equal((receivedOptions?.env as Record<string, unknown> | undefined)?.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(typeof handle.providerSessionId, "string");
  await handle.close();
});

test("preserves Claude events while a consumer briefly pauses", async () => {
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-queue-init", session_id: nativeSessionId });
        for (let index = 0; index < 400; index += 1) {
          yield sdk({
            type: "assistant",
            message: { id: `queue-message-${index}`, content: [{ type: "text", text: `message-${index}` }] },
            parent_tool_use_id: null,
            uuid: `event-queue-${index}`,
            session_id: nativeSessionId,
          });
        }
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "done", uuid: "event-queue-result", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const iterator = handle.run({ text: "stream" })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.kind, "turn.started");
  const ready = await iterator.next();
  assert.equal(ready.value?.kind, "session.ready");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const events: LocalRuntimeProviderEvent[] = [first.value!, ready.value!];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  assert.equal(events.filter((event) => event.kind === "text.delta").length, 400);
  assert.equal(events.at(-1)?.kind, "turn.completed");
  await handle.close();
});

test("does not duplicate normalized text carried in prompt content", async () => {
  let receivedMessage: unknown;
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt as AsyncIterable<unknown>) {
          receivedMessage = message;
          break;
        }
        yield sdk({ type: "system", subtype: "init", uuid: "event-prompt-init", session_id: nativeSessionId });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-prompt-result", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  for await (const _event of handle.run({
    text: "hello\n\nworld",
    content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
  })) {}
  const content = (receivedMessage as { message?: { content?: unknown[] } } | undefined)?.message?.content;
  assert.deepEqual(content, [{ type: "text", text: "hello" }, { type: "text", text: "world" }]);
  await handle.close();
});

test("uses provider-owned Claude configuration", async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const adapter = new ClaudeAdapter({
    configDir: "/tmp/cohub-claude-test",
    settingSources: ["user", "project"],
    env: { CLAUDE_TEST_FLAG: "yes" },
    queryFactory: ({ options }) => {
      receivedOptions = options as Record<string, unknown>;
      const nativeSessionId = String(options?.sessionId || "");
      return {
        async *[Symbol.asyncIterator]() {
          yield sdk({ type: "system", subtype: "init", uuid: "event-init-explicit", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-result-explicit", session_id: nativeSessionId });
        },
        close() {},
        async interrupt() {},
      } as unknown as Query;
    },
  });
  const handle = await adapter.open({
    cwd: "/workspace",
    providerSessionId: null,
  });
  for await (const _event of handle.run({ text: "hello" })) {}
  assert.equal(receivedOptions?.cwd, "/workspace");
  assert.deepEqual(receivedOptions?.settingSources, ["user", "project"]);
  assert.equal(receivedOptions?.persistSession, true);
  assert.equal((receivedOptions?.env as Record<string, unknown> | undefined)?.CLAUDE_CONFIG_DIR, "/tmp/cohub-claude-test");
  assert.equal((receivedOptions?.env as Record<string, unknown> | undefined)?.CLAUDE_TEST_FLAG, "yes");
  await handle.close();
});

test("emits only the per-turn delta for cumulative Claude costs", async () => {
  const batches: SDKMessage[][] = [
    [
      sdk({ type: "system", subtype: "init", uuid: "event-cost-init", session_id: sessionId }),
      sdk({ type: "result", subtype: "success", is_error: false, result: "first", total_cost_usd: 0.1, usage: { input_tokens: 2, output_tokens: 1 }, uuid: "event-cost-1", session_id: sessionId }),
    ],
    [
      sdk({ type: "result", subtype: "success", is_error: false, result: "second", total_cost_usd: 0.25, usage: { input_tokens: 3, output_tokens: 2 }, uuid: "event-cost-2", session_id: sessionId }),
    ],
  ];
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    const input = prompt as AsyncIterable<unknown>;
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        for await (const _message of input) {
          yield* (batches[index++] ?? []).map((message) => ({ ...message, session_id: nativeSessionId }));
        }
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const first = [];
  for await (const event of handle.run({ text: "one" })) first.push(event);
  const second = [];
  for await (const event of handle.run({ text: "two" })) second.push(event);
  const firstUsage = first.find((event) => event.kind === "usage")?.payload.usage as { cost?: { total?: number } } | undefined;
  const secondUsage = second.find((event) => event.kind === "usage")?.payload.usage as { cost?: { total?: number } } | undefined;
  assert.equal(firstUsage?.cost?.total, 0.1);
  assert.equal(secondUsage?.cost?.total, 0.15);
  await handle.close();
});

test("applies per-turn model and permission changes through the native query", async () => {
  const calls: string[] = [];
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-init", session_id: nativeSessionId });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-result", session_id: nativeSessionId });
      },
      setModel: async (model?: string) => { calls.push(`model:${model || "default"}`); },
      setPermissionMode: async (mode: string) => { calls.push(`permission:${mode}`); },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({
    cwd: "/workspace",
    providerSessionId: null,
    accessMode: "full_access",
    signal: new AbortController().signal,
  });
  const output = [];
  for await (const event of handle.run({
    text: "hello",
    options: { model: "claude-opus", accessMode: "full_access" },
  })) output.push(event);
  assert.deepEqual(calls, ["model:claude-opus", "permission:acceptEdits"]);
  assert.equal(output.at(-1)?.kind, "turn.completed");
  await handle.close();
});

test("uses a deterministic native tool policy for full and read-only sessions", async () => {
  const callbacks: Array<NonNullable<ClaudeOptions["canUseTool"]>> = [];
  const receivedTools: Array<ClaudeOptions["tools"]> = [];
  const receivedDisallowedTools: Array<string[] | undefined> = [];
  const adapter = new ClaudeAdapter(({ options }) => {
    if (options?.canUseTool) callbacks.push(options.canUseTool);
    receivedTools.push(options?.tools);
    receivedDisallowedTools.push(options?.disallowedTools);
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: `event-policy-${callbacks.length}`, session_id: nativeSessionId });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: `event-policy-result-${callbacks.length}`, session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });

  const full = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "full_access" });
  for await (const _event of full.run({ text: "full" })) {}
  const fullDecision = await callbacks[0]?.("Bash", { command: "printf ok" }, {
    signal: new AbortController().signal,
    toolUseID: "full-tool",
    requestId: "full-request",
  });
  assert.equal(fullDecision?.behavior, "allow");
  await full.close();

  const readOnly = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "read_only" });
  for await (const _event of readOnly.run({ text: "read" })) {}
  const readDecision = await callbacks[1]?.("Read", { file_path: "/workspace/a.txt" }, {
    signal: new AbortController().signal,
    toolUseID: "read-tool",
    requestId: "read-request",
  });
  const writeDecision = await callbacks[1]?.("Bash", { command: "rm -rf /workspace" }, {
    signal: new AbortController().signal,
    toolUseID: "write-tool",
    requestId: "write-request",
  });
  assert.equal(readDecision?.behavior, "allow");
  assert.equal(writeDecision?.behavior, "deny");
  assert.deepEqual(receivedTools[1], ["Read", "Glob", "Grep", "LS", "NotebookRead"]);
  assert.deepEqual(receivedDisallowedTools[1], [
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "MultiEdit",
    "Task",
    "Agent",
    "Skill",
    "TodoWrite",
    "ExitPlanMode",
  ]);
  const fetchDecision = await callbacks[1]?.("WebFetch", { url: "https://example.com" }, {
    signal: new AbortController().signal,
    toolUseID: "fetch-tool",
    requestId: "fetch-request",
  });
  const searchDecision = await callbacks[1]?.("WebSearch", { query: "secret" }, {
    signal: new AbortController().signal,
    toolUseID: "search-tool",
    requestId: "search-request",
  });
  assert.equal(fetchDecision?.behavior, "deny");
  assert.equal(searchDecision?.behavior, "deny");
  await readOnly.close();
});

test("rejects Claude Glob patterns outside the authorized workspace", async () => {
  let canUseTool: ClaudeOptions["canUseTool"] | undefined;
  const adapter = new ClaudeAdapter({
    queryFactory: ({ options }) => {
      canUseTool = options?.canUseTool;
      const nativeSessionId = String(options?.sessionId || "");
      return {
        async *[Symbol.asyncIterator]() {
          yield sdk({ type: "system", subtype: "init", uuid: "event-glob-policy-init", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-glob-policy-result", session_id: nativeSessionId });
        },
        close() {},
        async interrupt() {},
      } as unknown as Query;
    },
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "read_only" });
  for await (const _event of handle.run({ text: "inspect" })) {}
  const inside = await canUseTool?.("Glob", { pattern: "src/**/*.ts" }, {
    toolUseID: "glob-inside",
    requestId: "glob-inside-request",
  } as never);
  const absoluteOutside = await canUseTool?.("Glob", { pattern: "/etc/**" }, {
    toolUseID: "glob-absolute-outside",
    requestId: "glob-absolute-outside-request",
  } as never);
  const parentOutside = await canUseTool?.("Glob", { pattern: "../**" }, {
    toolUseID: "glob-parent-outside",
    requestId: "glob-parent-outside-request",
  } as never);
  const windowsParentOutside = await canUseTool?.("Glob", { pattern: "foo/..\\\\bar/**" }, {
    toolUseID: "glob-windows-parent-outside",
    requestId: "glob-windows-parent-outside-request",
  } as never);
  const braceOutside = await canUseTool?.("Glob", { pattern: "{src,../etc}/**" }, {
    toolUseID: "glob-brace-outside",
    requestId: "glob-brace-outside-request",
  } as never);
  const extglobOutside = await canUseTool?.("Glob", { pattern: "@(src|../etc)/**" }, {
    toolUseID: "glob-extglob-outside",
    requestId: "glob-extglob-outside-request",
  } as never);
  const absoluteBraceOutside = await canUseTool?.("Glob", { pattern: "{/etc,/workspace/src}/**" }, {
    toolUseID: "glob-absolute-brace-outside",
    requestId: "glob-absolute-brace-outside-request",
  } as never);
  const absoluteExtglobOutside = await canUseTool?.("Glob", { pattern: "@(/etc|src)/**" }, {
    toolUseID: "glob-absolute-extglob-outside",
    requestId: "glob-absolute-extglob-outside-request",
  } as never);
  const encodedOutside = await canUseTool?.("Glob", { pattern: "%2e%2e/etc/**" }, {
    toolUseID: "glob-encoded-outside",
    requestId: "glob-encoded-outside-request",
  } as never);
  const rangeOutside = await canUseTool?.("Glob", { pattern: "[!-/][!-/]/etc/**" }, {
    toolUseID: "glob-range-outside",
    requestId: "glob-range-outside-request",
  } as never);
  const safeRange = await canUseTool?.("Glob", { pattern: "src/[a-z][a-z]/**" }, {
    toolUseID: "glob-safe-range",
    requestId: "glob-safe-range-request",
  } as never);
  const characterClassOutside = await canUseTool?.("Glob", { pattern: "[.][.]/etc/**" }, {
    toolUseID: "glob-character-class-outside",
    requestId: "glob-character-class-outside-request",
  } as never);
  const dottedFilename = await canUseTool?.("Glob", { pattern: "src/foo..bar/**" }, {
    toolUseID: "glob-dotted-filename",
    requestId: "glob-dotted-filename-request",
  } as never);
  assert.equal(inside?.behavior, "allow");
  assert.equal(absoluteOutside?.behavior, "deny");
  assert.equal(parentOutside?.behavior, "deny");
  assert.equal(windowsParentOutside?.behavior, "deny");
  assert.equal(braceOutside?.behavior, "deny");
  assert.equal(extglobOutside?.behavior, "deny");
  assert.equal(absoluteBraceOutside?.behavior, "deny");
  assert.equal(absoluteExtglobOutside?.behavior, "deny");
  assert.equal(encodedOutside?.behavior, "deny");
  assert.equal(rangeOutside?.behavior, "deny");
  assert.equal(safeRange?.behavior, "allow");
  assert.equal(characterClassOutside?.behavior, "deny");
  assert.equal(dottedFilename?.behavior, "allow");
  await handle.close();
});

test("rejects a missing explicit Claude workspace root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-claude-workspace-root-"));
  const adapter = new ClaudeAdapter({
    queryFactory: () => {
      throw new Error("query must not be created");
    },
  });
  await assert.rejects(
    adapter.open({ cwd, workspaceRoot: join(cwd, "does-not-exist"), providerSessionId: null }),
    /workspace root is unavailable/,
  );
});

test("rejects a malformed Claude model before creating a query", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-claude-model-invalid-"));
  const adapter = new ClaudeAdapter({
    queryFactory: () => {
      throw new Error("query must not be created");
    },
  });
  await assert.rejects(
    adapter.open({ cwd, providerSessionId: null, model: 42 } as never),
    /Claude provider model must be a string or null/,
  );
});

test("rejects a Claude cwd outside the explicit workspace root", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cohub-claude-workspace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "cohub-claude-workspace-outside-"));
  const adapter = new ClaudeAdapter({
    queryFactory: () => {
      throw new Error("query must not be created");
    },
  });
  await assert.rejects(
    adapter.open({ cwd: outside, workspaceRoot, providerSessionId: null }),
    /cwd must stay inside the workspace/,
  );
});

test("rejects Claude resume when session persistence is disabled", async () => {
  const adapter = new ClaudeAdapter({
    persistSession: false,
    queryFactory: () => {
      throw new Error("query must not be created");
    },
  });
  await assert.rejects(
    adapter.open({
      cwd: "/workspace",
      providerSessionId: sessionId,
      operation: "session.resume",
    }),
    /Claude session\.resume requires persistSession to remain enabled/,
  );
});

test("passes Claude permission requests through an injected resolver", async () => {
  let request: { toolName?: string; toolUseId?: string; input?: Record<string, unknown> } | undefined;
  let canUseTool: ClaudeOptions["canUseTool"] | undefined;
  const adapter = new ClaudeAdapter({
    permissionResolver: (value) => {
      request = value;
      return { behavior: "allow", updatedInput: { approved: true } };
    },
    queryFactory: ({ options }) => {
      canUseTool = options?.canUseTool;
      const nativeSessionId = String(options?.sessionId || "");
      return {
        async *[Symbol.asyncIterator]() {
          yield sdk({ type: "system", subtype: "init", uuid: "event-permission-init", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-permission-result", session_id: nativeSessionId });
        },
        close() {},
        async interrupt() {},
      } as unknown as Query;
    },
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "full_access" });
  for await (const _event of handle.run({ text: "hello" })) {}
  assert.ok(canUseTool);
  const decision = await canUseTool?.("Bash", { command: "pwd" }, {
    signal: new AbortController().signal,
    toolUseID: "tool-permission",
    requestId: "request-permission",
  });
  assert.equal(decision?.behavior, "allow");
  assert.deepEqual(request, { requestId: "request-permission", toolName: "Bash", toolUseId: "tool-permission", input: { command: "pwd" } });
  await handle.close();
});

test("rejects resolver updatedInput paths outside the authorized workspace", async () => {
  let canUseTool: ClaudeOptions["canUseTool"] | undefined;
  const adapter = new ClaudeAdapter({
    permissionResolver: () => ({ behavior: "allow", updatedInput: { file_path: "/etc/passwd" } }),
    queryFactory: ({ options }) => {
      canUseTool = options?.canUseTool;
      const nativeSessionId = String(options?.sessionId || "");
      return {
        async *[Symbol.asyncIterator]() {
          yield sdk({ type: "system", subtype: "init", uuid: "event-updated-path-init", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-updated-path-result", session_id: nativeSessionId });
        },
        close() {},
        async interrupt() {},
      } as unknown as Query;
    },
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "full_access" });
  for await (const _event of handle.run({ text: "inspect" })) {}
  const decision = await canUseTool?.("Read", { file_path: "/workspace/allowed.txt" }, {
    signal: new AbortController().signal,
    toolUseID: "tool-updated-path",
    requestId: "request-updated-path",
  });
  assert.equal(decision?.behavior, "deny");
  assert.match(String(decision?.message), /outside the authorized workspace/);
  await handle.close();
});

test("accepts permission callbacks without an optional abort signal", async () => {
  let canUseTool: ClaudeOptions["canUseTool"] | undefined;
  const adapter = new ClaudeAdapter({
    permissionResolver: () => ({ behavior: "allow" }),
    queryFactory: ({ options }) => {
      canUseTool = options?.canUseTool;
      const nativeSessionId = String(options?.sessionId || "");
      return {
        async *[Symbol.asyncIterator]() {
          yield sdk({ type: "system", subtype: "init", uuid: "event-permission-no-signal-init", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-permission-no-signal-result", session_id: nativeSessionId });
        },
        close() {},
        async interrupt() {},
      } as unknown as Query;
    },
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, accessMode: "full_access" });
  for await (const _event of handle.run({ text: "hello" })) {}
  const decision = await canUseTool?.("Bash", { command: "pwd" }, {
    toolUseID: "tool-no-signal",
    requestId: "request-no-signal",
  } as never);
  assert.equal(decision?.behavior, "allow");
  await handle.close();
});

test("keeps per-turn cancellation separate from the native session abort controller", async () => {
  let resolveQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => { resolveQueryStarted = resolve; });
  let nativeAbortController: AbortController | undefined;
  let interruptCalls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const adapter = new ClaudeAdapter(({ options }) => {
    nativeAbortController = options?.abortController;
    resolveQueryStarted();
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-abort-init", session_id: nativeSessionId });
        await blocked;
      },
      close() { unblock(); },
      async interrupt() { interruptCalls += 1; unblock(); },
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const turnAbort = new AbortController();
  const events: LocalRuntimeProviderEvent[] = [];
  const running = (async () => {
    for await (const event of handle.run({ text: "cancel me" }, turnAbort.signal)) events.push(event);
  })();
  await queryStarted;
  turnAbort.abort(new Error("turn stopped"));
  await running;
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(interruptCalls, 1);
  assert.equal(nativeAbortController?.signal.aborted, false);
  await handle.close();
});

test("aborting the Claude session aborts the native query controller", async () => {
  let resolveQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => { resolveQueryStarted = resolve; });
  let nativeAbortController: AbortController | undefined;
  let interruptCalls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const sessionAbort = new AbortController();
  const adapter = new ClaudeAdapter(({ options }) => {
    nativeAbortController = options?.abortController;
    resolveQueryStarted();
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-session-abort-init", session_id: nativeSessionId });
        await blocked;
      },
      close() { unblock(); },
      async interrupt() { interruptCalls += 1; unblock(); },
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null, signal: sessionAbort.signal });
  const events: LocalRuntimeProviderEvent[] = [];
  const running = (async () => {
    for await (const event of handle.run({ text: "cancel session" })) events.push(event);
  })();
  await queryStarted;
  sessionAbort.abort(new Error("session stopped"));
  await running;
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(interruptCalls, 1);
  assert.equal(nativeAbortController?.signal.aborted, true);
  await handle.close();
});

test("fails fast when the native Claude query stream has ended", async () => {
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || "");
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-eof-init", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  for await (const _event of handle.run({ text: "first" })) {}
  const second = [];
  for await (const event of handle.run({ text: "second" })) second.push(event);
  assert.deepEqual(second.map((event) => event.kind), ["turn.started", "turn.failed"]);
  assert.equal(second.at(-1)?.payload.code, "provider_stream_ended");
  await handle.close();
});

test("keeps a cancellation failure queued when setup is interrupted", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const adapter = new ClaudeAdapter(() => {
    return {
      async *[Symbol.asyncIterator]() {
        yield* [] as SDKMessage[];
        await blocked;
      },
      close() { unblock(); },
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const signal = new AbortController();
  const iterator = handle.run({ text: "cancel before setup" }, signal.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");
  signal.abort(new Error("setup stopped"));
  const terminal = await iterator.next();
  assert.equal(terminal.value?.kind, "turn.failed");
  assert.equal(terminal.value?.payload.code, "cancelled");
  assert.equal((await iterator.next()).done, true);
  await handle.close();
});

test("rejects malformed Claude prompt blocks before creating a native query", async () => {
  let queryCreated = false;
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    queryCreated = true;
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _message of prompt as AsyncIterable<unknown>) {
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "unexpected", uuid: "event-malformed-result", session_id: nativeSessionId });
        }
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const events: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({
    text: "hello",
    content: [{ type: "text", text: 42 }],
  } as never)) events.push(event);
  assert.equal(queryCreated, false);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.code, "provider_error");
  await handle.close();
});

test("converts normalized thinking blocks into Claude text content", async () => {
  let receivedMessage: unknown;
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt as AsyncIterable<unknown>) {
          receivedMessage = message;
          yield sdk({ type: "system", subtype: "init", uuid: "event-thinking-init", session_id: nativeSessionId });
          yield sdk({ type: "result", subtype: "success", is_error: false, result: "ok", uuid: "event-thinking-result", session_id: nativeSessionId });
          break;
        }
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  for await (const _event of handle.run({
    text: "",
    content: [{ type: "thinking", thinking: "private context" }],
  })) {}
  const content = (receivedMessage as { message?: { content?: unknown[] } } | undefined)?.message?.content;
  assert.deepEqual(content, [{ type: "text", text: "private context" }]);
  await handle.close();
});

test("splits large Unicode Claude deltas without invalid UTF-8 or oversized events", () => {
  const context = createClaudeEventContext(sessionId, "turn-large-unicode");
  const text = "🙂漢字".repeat(220_000);
  const events = mapClaudeMessage(sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    uuid: "event-large-unicode",
    session_id: sessionId,
  }), context);
  assert.ok(events.length > 1);
  assert.equal(events.every((event) => !String(event.payload.text).includes("\uFFFD")), true);
  assert.equal(events.map((event) => String(event.payload.text)).join(""), text);
  assert.equal(events.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") < 3 * 1024 * 1024), true);
});

test("bounds Claude tool input, output, and result payloads", () => {
  const context = createClaudeEventContext(sessionId, "turn-large-tool-values");
  const huge = "x".repeat(600_000);
  const started = mapClaudeMessage(sdk({
    type: "assistant",
    message: { id: "message-large-tool", content: [{ type: "tool_use", id: "tool-large", name: "Read", input: { value: huge } }] },
    parent_tool_use_id: null,
    uuid: "event-large-tool-start",
    session_id: sessionId,
  }), context);
  assert.equal(started[0]?.payload.input && JSON.stringify(started[0].payload.input), JSON.stringify({ truncated: true }));
  const completed = mapClaudeMessage(sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-large", content: huge }] },
    parent_tool_use_id: null,
    uuid: "event-large-tool-result",
    session_id: sessionId,
  }), context);
  assert.equal(Buffer.byteLength(String(completed[0]?.payload.output || ""), "utf8") <= 256 * 1024, true);
  const result = mapClaudeMessage(sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: huge,
    uuid: "event-large-result",
    session_id: sessionId,
  }), context);
  assert.equal(result.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") < 3 * 1024 * 1024), true);
});

test("accepts canonical Claude UUIDv7 provider session ids", async () => {
  const providerSessionId = "018f0f7b-4a6b-7abc-8def-0123456789ab";
  const adapter = new ClaudeAdapter(() => ({
    async *[Symbol.asyncIterator]() {},
    close() {},
    async interrupt() {},
  } as unknown as Query));
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId, operation: "session.resume" });
  assert.equal(handle.providerSessionId, providerSessionId);
  await handle.close();
});

test("does not attribute a post-result task notification to the next Claude turn", async () => {
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        const first = await input.next();
        const firstUuid = String(first.value?.uuid || "");
        yield sdk({ type: "system", subtype: "task_started", task_id: "late-task", uuid: "event-late-task-start", session_id: nativeSessionId });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "first", user_message_uuid: firstUuid, uuid: "event-late-result", session_id: nativeSessionId });
        const second = await input.next();
        const secondUuid = String(second.value?.uuid || "");
        yield sdk({
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second" } },
          user_message_uuid: secondUuid,
          uuid: "event-second-stream",
          session_id: nativeSessionId,
        });
        yield sdk({ type: "system", subtype: "task_notification", task_id: "late-task", status: "completed", summary: "stale task", uuid: "event-late-task-notification", session_id: nativeSessionId });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "second", user_message_uuid: secondUuid, uuid: "event-second-result", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const first: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "first" })) first.push(event);
  const second: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "second" })) second.push(event);
  assert.equal(first.at(-1)?.kind, "turn.completed");
  assert.deepEqual(second.map((event) => event.kind), ["turn.started", "text.delta", "turn.completed"]);
  await handle.close();
});

test("does not attribute a late Claude tool result to the next turn", async () => {
  const adapter = new ClaudeAdapter(({ prompt, options }) => {
    const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        const first = await input.next();
        const firstUuid = String(first.value?.uuid || "");
        yield sdk({
          type: "assistant",
          message: { id: "late-tool-message", content: [{ type: "tool_use", id: "late-tool", name: "Read", input: {} }] },
          parent_tool_use_id: null,
          uuid: "event-late-tool-start",
          user_message_uuid: firstUuid,
          session_id: nativeSessionId,
        });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "first", user_message_uuid: firstUuid, uuid: "event-late-tool-result", session_id: nativeSessionId });
        const second = await input.next();
        const secondUuid = String(second.value?.uuid || "");
        yield sdk({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "late-tool", content: "stale" }] },
          uuid: "event-late-user-tool-result",
          session_id: nativeSessionId,
        });
        yield sdk({ type: "result", subtype: "success", is_error: false, result: "second", user_message_uuid: secondUuid, uuid: "event-second-result", session_id: nativeSessionId });
      },
      close() {},
      async interrupt() {},
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const first: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "first" })) first.push(event);
  const second: LocalRuntimeProviderEvent[] = [];
  for await (const event of handle.run({ text: "second" })) second.push(event);
  assert.deepEqual(second.map((event) => event.kind), ["turn.started", "turn.completed"]);
  await handle.close();
});

test("interrupts a native Claude turn when its async iterator closes early", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let interruptCalls = 0;
  const adapter = new ClaudeAdapter(({ options }) => {
    const nativeSessionId = String(options?.sessionId || sessionId);
    return {
      async *[Symbol.asyncIterator]() {
        yield sdk({ type: "system", subtype: "init", uuid: "event-early-close-init", session_id: nativeSessionId });
        await blocked;
      },
      close() { unblock(); },
      async interrupt() { interruptCalls += 1; unblock(); },
    } as unknown as Query;
  });
  const handle = await adapter.open({ cwd: "/workspace", providerSessionId: null });
  const iterator = handle.run({ text: "stop after ready" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");
  assert.equal((await iterator.next()).value?.kind, "session.ready");
  await iterator.return?.();
  assert.equal(interruptCalls, 1);
  await handle.close();
});
