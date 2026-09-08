import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LocalRuntimeProviderEvent } from "@cohub/protocol";
import { PiProviderAdapter, PiProviderSession } from "@cohub/local-runtime/providers/pi";

type FakeSession = {
  session: AgentSession;
  emit: (event: AgentSessionEvent) => void;
  calls: Array<{ text: string; options: Record<string, unknown> | undefined }>;
  setPrompt: (prompt: () => Promise<void>) => void;
  setAbort: (abort: () => Promise<void>) => void;
  setMessages: (messages: unknown[]) => void;
  setStreaming: (value: boolean) => void;
  get activeToolNames(): string[];
  get abortCalls(): number;
};

function fakeSession(cwd: string, sessionId = "pi-test-session"): FakeSession {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let prompt: () => Promise<void> = async () => {};
  let abort: () => Promise<void> = async () => {};
  let streaming = false;
  let messages: unknown[] = [];
  let activeToolNames = ["read", "write"];
  const allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  let abortCalls = 0;
  const agent = { beforeToolCall: undefined as AgentSession["agent"]["beforeToolCall"] };
  const calls: Array<{ text: string; options: Record<string, unknown> | undefined }> = [];
  const session = {
    sessionId,
    sessionManager: { getCwd: () => cwd },
    agent,
    get isStreaming() {
      return streaming;
    },
    get messages() {
      return messages;
    },
    getActiveToolNames() {
      return activeToolNames.slice();
    },
    getAllTools() {
      return allToolNames.map((name) => ({ name })) as never;
    },
    setActiveToolsByName(names: string[]) {
      activeToolNames = names.slice();
    },
    subscribe(callback: (event: AgentSessionEvent) => void) {
      listener = callback;
      return () => {
        if (listener === callback) listener = undefined;
      };
    },
    async prompt(text: string, options?: Record<string, unknown>) {
      calls.push({ text, options });
      streaming = true;
      await prompt();
      streaming = false;
    },
    async abort() {
      abortCalls += 1;
      streaming = false;
      await abort();
    },
    async setModel() {},
    dispose() {},
  } as unknown as AgentSession;
  return {
    session,
    emit: (event) => listener?.(event),
    calls,
    setPrompt: (next) => {
      prompt = next;
    },
    setAbort: (next) => {
      abort = next;
    },
    setMessages: (next) => {
      messages = next;
    },
    setStreaming: (next) => {
      streaming = next;
    },
    get activeToolNames() {
      return activeToolNames.slice();
    },
    get abortCalls() {
      return abortCalls;
    },
  };
}

async function collect(iterable: AsyncIterable<LocalRuntimeProviderEvent>): Promise<LocalRuntimeProviderEvent[]> {
  const events: LocalRuntimeProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("maps Pi SDK events and emits completion after agent_settled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-test-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", responseId: "response-1", content: [{ type: "text", text: "Hello" }], stopReason: "stop" };
    fake.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: assistant } } as AgentSessionEvent);
    fake.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan", partial: assistant } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "a.txt" } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "read", args: { path: "a.txt" }, partialResult: { content: "partial" } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: "done" }, isError: false } as AgentSessionEvent);
    const final = { ...assistant, usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.setMessages([final]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "read_only" });
  const events = await collect(session.run({ text: "hello" }));
  assert.deepEqual(events.map((event) => event.kind), [
    "turn.started",
    "text.delta",
    "thinking.delta",
    "tool.started",
    "tool.updated",
    "tool.completed",
    "usage",
    "turn.completed",
  ]);
  assert.equal(events.at(-1)?.payload.output, "Hello");
  assert.equal(events.at(-1)?.payload.status, "turn_completed");
  await session.close();
});

test("bounds oversized Pi stream, terminal, and tool events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-event-size-"));
  const fake = fakeSession(cwd);
  const text = "x".repeat(2 * 1024 * 1024);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", responseId: "large-response", content: [{ type: "text", text }], stopReason: "stop" };
    fake.emit({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistant },
    } as AgentSessionEvent);
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "large-tool",
      toolName: "read",
      args: { path: "a.txt", detail: text },
    } as AgentSessionEvent);
    fake.emit({
      type: "tool_execution_update",
      toolCallId: "large-tool",
      toolName: "read",
      args: { path: "a.txt", detail: text },
      partialResult: text,
    } as AgentSessionEvent);
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "large-tool",
      toolName: "read",
      result: text,
      isError: false,
    } as AgentSessionEvent);
    fake.setMessages([assistant]);
    fake.emit({ type: "message_end", message: assistant } as AgentSessionEvent);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const events = await collect(session.run({ text: "large" }));
  assert.ok(events.some((event) => event.kind === "text.delta"));
  assert.equal(events.filter((event) => event.kind === "text.delta").map((event) => String(event.payload.text)).join(""), text);
  assert.equal((events.find((event) => event.kind === "tool.started")?.payload.input as Record<string, unknown>)?.truncated, true);
  assert.ok(String(events.find((event) => event.kind === "tool.updated")?.payload.output ?? "").length <= 256 * 1024);
  assert.ok(String(events.find((event) => event.kind === "turn.completed")?.payload.output ?? "").length <= 512 * 1024);
  assert.ok(events.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") < 4 * 1024 * 1024));
  await session.close();
});

test("assigns stable unique ids to repeated Pi stream updates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-event-ids-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const first = { role: "assistant", responseId: "response-reused", content: [{ type: "text", text: "a" }] };
    const second = { role: "assistant", responseId: "response-reused", content: [{ type: "text", text: "ab" }] };
    const firstUpdate = { type: "text_delta", contentIndex: 0, delta: "a", partial: first };
    const secondUpdate = { type: "text_delta", contentIndex: 0, delta: "b", partial: second };
    fake.emit({ type: "message_update", message: first, assistantMessageEvent: firstUpdate } as AgentSessionEvent);
    fake.emit({ type: "message_update", message: second, assistantMessageEvent: secondUpdate } as AgentSessionEvent);
    // Re-delivering an identical SDK update must remain idempotent.
    fake.emit({ type: "message_update", message: second, assistantMessageEvent: secondUpdate } as AgentSessionEvent);
    const firstTool = { content: [{ type: "text", text: "one" }] };
    const secondTool = { content: [{ type: "text", text: "two" }] };
    fake.emit({ type: "tool_execution_update", toolCallId: "tool-reused", toolName: "read", args: { path: "a.txt" }, partialResult: firstTool } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_update", toolCallId: "tool-reused", toolName: "read", args: { path: "a.txt" }, partialResult: secondTool } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_update", toolCallId: "tool-reused", toolName: "read", args: { path: "a.txt" }, partialResult: secondTool } as AgentSessionEvent);
    const final = { ...second, content: [{ type: "text", text: "ab" }], stopReason: "stop" };
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.setMessages([final]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const events = await collect(session.run({ text: "ids" }));
  const streamEvents = events.filter((event) => ["text.delta", "tool.updated"].includes(event.kind));
  assert.equal(streamEvents.length, 6);
  assert.equal(new Set(streamEvents.map((event) => event.providerEventId)).size, 4);
  assert.equal(streamEvents[1]?.providerEventId, streamEvents[2]?.providerEventId);
  assert.equal(streamEvents[4]?.providerEventId, streamEvents[5]?.providerEventId);
  assert.notEqual(streamEvents[0]?.providerEventId, streamEvents[1]?.providerEventId);
  await session.close();
});

test("correlates Pi tool lifecycle events when the native id is missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-anonymous-tool-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const tool = { toolCallId: undefined, toolName: "read", args: { path: "a.txt" } };
    fake.emit({ type: "tool_execution_start", ...tool } as unknown as AgentSessionEvent);
    fake.emit({ type: "tool_execution_update", ...tool, partialResult: "reading" } as unknown as AgentSessionEvent);
    fake.emit({ type: "tool_execution_end", toolCallId: undefined, toolName: "read", result: "done", isError: false } as unknown as AgentSessionEvent);
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "anonymous" }));
  const started = events.find((event) => event.kind === "tool.started");
  const updated = events.find((event) => event.kind === "tool.updated");
  const completed = events.find((event) => event.kind === "tool.completed");
  assert.ok(started && updated && completed);
  assert.equal(started.payload.id, updated.payload.id);
  assert.equal(updated.payload.id, completed.payload.id);
  assert.notEqual(started.providerEventId, completed.providerEventId);
  await session.close();
});

test("fingerprints Pi tool lifecycle revisions when a native id is reused", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-tool-revisions-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.emit({ type: "tool_execution_start", toolCallId: "reused", toolName: "read", args: { path: "a.txt" } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_end", toolCallId: "reused", toolName: "read", result: "one", isError: false } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_start", toolCallId: "reused", toolName: "read", args: { path: "b.txt" } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_end", toolCallId: "reused", toolName: "read", result: "two", isError: false } as AgentSessionEvent);
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "reused" }));
  const completed = events.filter((event) => event.kind === "tool.completed");
  assert.equal(completed.length, 2);
  assert.notEqual(completed[0]?.providerEventId, completed[1]?.providerEventId);
  await session.close();
});

test("scopes Pi tool event ids to the current turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-tool-turn-ids-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.emit({ type: "tool_execution_start", toolCallId: "reused", toolName: "read", args: { path: "a.txt" } } as AgentSessionEvent);
    fake.emit({ type: "tool_execution_end", toolCallId: "reused", toolName: "read", result: "done", isError: false } as AgentSessionEvent);
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const first = await collect(session.run({ text: "one" }));
  const second = await collect(session.run({ text: "two" }));
  const firstCompleted = first.find((event) => event.kind === "tool.completed");
  const secondCompleted = second.find((event) => event.kind === "tool.completed");
  assert.ok(firstCompleted?.providerEventId);
  assert.ok(secondCompleted?.providerEventId);
  assert.notEqual(firstCompleted?.providerEventId, secondCompleted?.providerEventId);
  await session.close();
});

test("does not reuse an assistant message from an earlier Pi turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-stale-assistant-"));
  const fake = fakeSession(cwd);
  fake.setMessages([{ role: "assistant", content: [{ type: "text", text: "old" }], stopReason: "stop" }]);
  fake.setPrompt(async () => {
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "new" }));
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.code, "provider_error");
  await session.close();
});

test("resumes an existing native Pi session instead of creating a replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-resume-"));
  const fake = fakeSession(cwd, "prior-session");
  const calls: string[] = [];
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [{ id: "prior-session", path: "/tmp/prior-session.jsonl", cwd }],
      open: (path) => {
        calls.push(`open:${path}`);
        return manager;
      },
      create: () => {
        calls.push("create");
        return manager;
      },
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd, providerSessionId: "prior-session" });
  assert.deepEqual(calls, ["open:/tmp/prior-session.jsonl"]);
  assert.equal(handle.providerSessionId, "prior-session");
  await handle.close();
});

test("uses an adapter session id as the default resume target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-adapter-session-id-"));
  const fake = fakeSession(cwd, "prior-session");
  const calls: string[] = [];
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    sessionId: "prior-session",
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [{ id: "prior-session", path: "/tmp/prior-session.jsonl", cwd }],
      open: (path) => {
        calls.push(`open:${path}`);
        return manager;
      },
      create: () => {
        calls.push("create");
        return manager;
      },
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd });
  assert.deepEqual(calls, ["open:/tmp/prior-session.jsonl"]);
  assert.equal(handle.providerSessionId, "prior-session");
  await handle.close();
});

test("persists a new Pi session before its first assistant message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-empty-session-"));
  const sessionDir = join(cwd, "sessions");
  const manager = SessionManager.create(cwd, sessionDir, { id: "durable-empty-session" });
  const fake = fakeSession(cwd, "durable-empty-session");
  (fake.session as unknown as { sessionManager: SessionManager }).sessionManager = manager;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: manager,
    createAgentSession: async () => ({ session: fake.session }),
  });

  const handle = await adapter.open({ cwd, operation: "session.open" });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.type, "session");
  assert.equal(lines[0]?.id, "durable-empty-session");
  assert.ok((await SessionManager.list(cwd, sessionDir)).some((entry) => entry.id === "durable-empty-session"));

  // The SDK uses an exclusive create for its first assistant append. The
  // adapter's durable header must leave that append path healthy.
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] } as never);
  assert.equal((await readFile(sessionFile, "utf8")).trim().split("\n").length, 2);
  await handle.close();
});

test("rejects a native resume identity mismatch and disposes the session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-resume-mismatch-"));
  const fake = fakeSession(cwd);
  let disposed = false;
  (fake.session as unknown as { dispose: () => void }).dispose = () => { disposed = true; };
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [{ id: "requested-session", path: "/tmp/requested-session.jsonl", cwd }],
      open: () => manager,
      create: () => manager,
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, providerSessionId: "requested-session", operation: "session.resume" }),
    /expected requested-session/,
  );
  assert.equal(disposed, true);
});

test("rejects an oversized native Pi session identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-session-id-size-"));
  const fake = fakeSession(cwd, "x".repeat(256));
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: manager,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(() => adapter.open({ cwd }), /oversized native session id/);
});

test("rejects a multibyte oversized native Pi session identity and disposes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-session-id-unicode-"));
  const fake = fakeSession(cwd, "界".repeat(128));
  let disposed = false;
  (fake.session as unknown as { dispose: () => void }).dispose = () => { disposed = true; };
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: manager,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(() => adapter.open({ cwd }), /oversized native session id/);
  assert.equal(disposed, true);
});

test("rejects a Pi fork that reuses the source identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-fork-mismatch-"));
  const fake = fakeSession(cwd, "source-session");
  let disposed = false;
  (fake.session as unknown as { dispose: () => void }).dispose = () => { disposed = true; };
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [{ id: "source-session", path: "/tmp/source-session.jsonl", cwd }],
      open: () => manager,
      create: () => manager,
      fork: () => manager,
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, providerSessionId: "source-session", operation: "session.fork" }),
    /must return a new providerSessionId/,
  );
  assert.equal(disposed, true);
});

test("preserves top-level and structured Pi prompt text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-content-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  await collect(session.run({
    text: "direct",
    content: [
      { type: "text", text: "context" },
      { type: "shell_command", command: "ls", rawText: "$ ls" },
      { type: "system_note", note_type: "info", text: "note" },
    ],
  }));
  assert.equal(fake.calls[0]?.text, "direct\n\ncontext\n\n$ ls\n\nnote");
  await session.close();
});

test("forwards Pi images supplied through turn options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-images-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  await collect(session.run({ text: "inspect", options: { images: [{ type: "base64", data: "aGVsbG8=", mimeType: "image/png" }] } }));
  const images = fake.calls[0]?.options?.images as Array<unknown> | undefined;
  assert.equal(images?.length, 1);
  assert.deepEqual(images?.[0], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });

  const malformed = await collect(session.run({
    text: "inspect",
    options: { images: [{ type: "base64", data: "AB==", mimeType: "image/png" }] },
  }));
  assert.equal(malformed.at(-1)?.kind, "turn.failed");
  assert.match(String(malformed.at(-1)?.payload.message), /not valid base64/);
  await session.close();
});

test("rejects non-image Pi image MIME types", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-image-mime-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({
    text: "inspect",
    options: { images: [{ type: "base64", data: "aGVsbG8=", mimeType: "text/plain" }] },
  }));
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(String(events.at(-1)?.payload.message), /MIME type must be an image/);
  assert.equal(fake.calls.length, 0);
  await session.close();
});

test("fails a Pi turn before subscribing when its signal is already aborted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-pre-abort-"));
  const fake = fakeSession(cwd);
  const signal = new AbortController();
  signal.abort(new Error("already stopped"));
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "do not run" }, signal.signal));
  assert.deepEqual(events.map((event) => event.kind), ["turn.failed"]);
  assert.equal(events[0]?.payload.code, "aborted");
  assert.equal(fake.calls.length, 0);
  await session.close();
});

test("does not silently ignore a Pi per-turn model without a model runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-model-runtime-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "select", options: { model: "provider/model" } }));
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.match(String(events.at(-1)?.payload.message), /model runtime is unavailable/);
  assert.equal(fake.calls.length, 0);
  await session.close();
});

test("rejects malformed Pi prompt text and options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-prompt-validation-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd });
  const invalidText = await collect(session.run({ text: 42 as unknown as string }));
  assert.match(String(invalidText.at(-1)?.payload.message), /prompt text must be a string/);
  const invalidOptions = await collect(session.run({ text: "hello", options: [] as unknown as Record<string, unknown> }));
  assert.match(String(invalidOptions.at(-1)?.payload.message), /prompt options must be an object/);
  assert.equal(fake.calls.length, 0);
  await session.close();
});

test("rejects unsupported and malformed Pi content blocks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-content-validation-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd });
  const unsupported = await collect(session.run({ text: "hello", content: [{ type: "thinking", thinking: "internal" }] }));
  assert.equal(unsupported.at(-1)?.kind, "turn.failed");
  assert.match(String(unsupported.at(-1)?.payload.message), /unsupported/);
  const malformed = await collect(session.run({ text: "hello", content: [null as never] }));
  assert.equal(malformed.at(-1)?.kind, "turn.failed");
  assert.match(String(malformed.at(-1)?.payload.message), /malformed/);
  assert.equal(fake.calls.length, 0);
  await session.close();
});

test("surfaces Pi subscription failures through the async iterator", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-subscribe-error-"));
  const fake = fakeSession(cwd);
  (fake.session as unknown as { subscribe: () => never }).subscribe = () => {
    throw new Error("subscription failed");
  };
  const session = new PiProviderSession(fake.session, { cwd });
  await assert.rejects(() => collect(session.run({ text: "hello" })), /subscription failed/);
  await session.close();
});

test("disables native Pi retries in the SDK settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-settings-"));
  const fake = fakeSession(cwd);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3 } });
  let receivedSettings: SettingsManager | undefined;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: fake.session.sessionManager as never,
    settingsManager,
    createAgentSession: async (options) => {
      receivedSettings = options.settingsManager;
      return { session: fake.session };
    },
  });
  const handle = await adapter.open({ cwd });
  assert.equal(receivedSettings?.getRetryEnabled(), false);
  assert.equal(settingsManager.getRetryEnabled(), true);
  await handle.close();
});

test("rejects native Pi retry opt-in before opening a session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-retry-opt-in-"));
  let createCalls = 0;
  const adapter = new PiProviderAdapter({
    autoRetry: true,
    createAgentSession: async () => {
      createCalls += 1;
      throw new Error("unexpected session creation");
    },
  });
  await assert.rejects(
    () => adapter.open({ cwd }),
    /native auto-retry is unavailable/,
  );
  assert.equal(createCalls, 0);
});

test("fails a resume when the native session is missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-missing-resume-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [],
      open: () => fake.session.sessionManager as never,
      create: () => fake.session.sessionManager as never,
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, providerSessionId: "missing-session", operation: "session.resume" }),
    /session was not found/,
  );
});

test("forks an existing native Pi session through SessionManager.forkFrom", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-fork-"));
  const fake = fakeSession(cwd);
  const calls: string[] = [];
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [{ id: "source-session", path: "/tmp/source-session.jsonl", cwd }],
      open: () => manager,
      create: () => manager,
      fork: (path, targetCwd) => {
        calls.push(`fork:${path}:${targetCwd}`);
        return manager;
      },
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd, providerSessionId: "source-session", operation: "session.fork" });
  assert.deepEqual(calls, [`fork:/tmp/source-session.jsonl:${cwd}`]);
  await handle.close();
});

test("rejects concurrent turns and propagates cancellation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-abort-"));
  const fake = fakeSession(cwd);
  let resolvePrompt!: () => void;
  fake.setPrompt(() => new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  }));
  const session = new PiProviderSession(fake.session, { cwd });
  const first = session.run({ text: "wait" });
  const firstIterator = first[Symbol.asyncIterator]();
  assert.equal((await firstIterator.next()).value?.kind, "turn.started");
  const second = await collect(session.run({ text: "second" }));
  assert.equal(second[0]?.kind, "turn.failed");
  assert.equal(second[0]?.payload.code, "concurrent_turn");
  const running = collect({ [Symbol.asyncIterator]: () => firstIterator });
  session.cancel("test cancellation");
  resolvePrompt();
  const events = await running;
  assert.equal(fake.abortCalls, 1);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.aborted, true);
  await session.close();
});

test("blocks write tools in read-only mode and emits canonical events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-runtime-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "full_access",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd, accessMode: "read_only" });
  const guard = fake.session.agent.beforeToolCall;
  assert.ok(guard);
  const blocked = await guard?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "tool-1", name: "write", arguments: {} },
    args: { path: "a.txt" },
    context: {} as never,
  });
  assert.equal(blocked?.block, true);
  const blockedCustom = await guard?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "tool-2", name: "custom-mutator", arguments: {} },
    args: {},
    context: {} as never,
  });
  assert.equal(blockedCustom?.block, true);
  const allowedUppercaseRead = await guard?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "tool-3", name: "READ", arguments: {} },
    args: { path: "a.txt" },
    context: {} as never,
  });
  assert.equal(allowedUppercaseRead, undefined);
  const events = await collect(handle.run({ text: "hello" }));
  assert.deepEqual(events.map((event) => event.kind), ["turn.started", "turn.completed"]);
  await handle.close();
});

test("does not let Pi payload access mode widen a read-only session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-access-ceiling-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "read_only",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, payload: { accessMode: "full_access" } }),
    /cannot widen a read-only session/,
  );
});

test("does not let Pi payload tools exceed the adapter ceiling", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-tools-ceiling-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    tools: ["read", "bash"],
    accessMode: "full_access",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, accessMode: "full_access", payload: { tools: ["read", "write"] } }),
    /tools exceed the adapter tool ceiling/,
  );
  assert.deepEqual(fake.activeToolNames, ["read", "write"]);
});

test("rejects malformed Pi payload tool lists instead of widening defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-tools-invalid-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "full_access",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, accessMode: "full_access", payload: { tools: ["read", 42] } }),
    /provider tools must be a string array/,
  );
});

test("rejects a relative Pi workspace root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-workspace-root-relative-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "full_access",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, workspaceRoot: "relative-workspace-root", accessMode: "full_access" }),
    /workspaceRoot must be an absolute path/,
  );
});

test("rejects a missing Pi workspace root instead of widening to its parent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-workspace-root-missing-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "full_access",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  await assert.rejects(
    () => adapter.open({ cwd, workspaceRoot: join(cwd, "does-not-exist"), accessMode: "full_access" }),
    /workspace root is unavailable/,
  );
});

test("blocks direct Pi tool access when its workspace root disappears", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-workspace-root-direct-missing-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, {
    cwd,
    workspaceRoot: join(cwd, "does-not-exist"),
    accessMode: "full_access",
  });
  const blocked = await fake.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "missing-root", name: "read", arguments: {} },
    args: { path: "/workspace/notes.txt" },
    context: {} as never,
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /workspace root is unavailable/);
  await session.close();
});

test("rejects a relative workspace root on direct Pi sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-direct-workspace-root-relative-"));
  const fake = fakeSession(cwd);
  assert.throws(
    () => new PiProviderSession(fake.session, { cwd, workspaceRoot: "relative-workspace-root" }),
    /workspaceRoot must be an absolute path/,
  );
  assert.throws(
    () => new PiProviderSession(fake.session, { cwd, workspaceRoot: "" }),
    /workspaceRoot must be an absolute path/,
  );
  assert.throws(
    () => new PiProviderSession(fake.session, { cwd: "relative-cwd" }),
    /cwd must be an absolute path/,
  );
});

test("ignores legacy Pi metadata provider options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-metadata-options-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    accessMode: "read_only",
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  const input = {
    cwd,
    accessMode: "read_only",
    metadata: { accessMode: "full_access", tools: ["write"] },
  } as unknown as Parameters<typeof adapter.open>[0];
  const handle = await adapter.open(input);
  assert.deepEqual(fake.activeToolNames, ["read", "grep", "find", "ls"]);
  await handle.close();
});

test("does not let Pi turn options widen a read-only session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-turn-access-ceiling-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "read_only" });
  const events = await collect(session.run({ text: "blocked", options: { accessMode: "full_access" } }));
  assert.deepEqual(events.map((event) => event.kind), ["turn.failed"]);
  assert.equal(events[0]?.payload.code, "access_mode_widening");
  assert.deepEqual(fake.activeToolNames, ["read", "grep", "find", "ls"]);
  await session.close();
});

test("allows a provider payload to downgrade a full-access Pi session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-payload-access-downgrade-"));
  const fake = fakeSession(cwd);
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: fake.session.sessionManager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd, accessMode: "full_access", payload: { accessMode: "read_only" } });
  assert.deepEqual(fake.activeToolNames, ["read", "grep", "find", "ls"]);
  await handle.close();
});

test("allows a full-access Pi session to downgrade and restore access", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-access-downgrade-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const readOnlyTurn = session.run({ text: "read", options: { accessMode: "read_only" } });
  assert.deepEqual(fake.activeToolNames, ["read"]);
  await collect(readOnlyTurn);
  const fullAccessTurn = session.run({ text: "write", options: { accessMode: "full_access" } });
  assert.deepEqual(fake.activeToolNames, ["read", "write"]);
  await collect(fullAccessTurn);
  await session.close();
});

test("restores Pi permission hooks and active tools when closing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-permission-restore-"));
  const fake = fakeSession(cwd);
  const previousHook = async () => undefined;
  fake.session.agent.beforeToolCall = previousHook;
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "read_only" });
  assert.notEqual(fake.session.agent.beforeToolCall, previousHook);
  assert.deepEqual(fake.activeToolNames, ["read", "grep", "find", "ls"]);
  await session.close();
  assert.equal(fake.session.agent.beforeToolCall, previousHook);
  assert.deepEqual(fake.activeToolNames, ["read", "write"]);
});

test("rechecks Pi tool paths after a chained hook mutates arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-hook-path-"));
  const fake = fakeSession(cwd);
  fake.session.agent.beforeToolCall = async (context) => {
    (context.args as Record<string, unknown>).path = "/etc/passwd";
    return undefined;
  };
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const result = await fake.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "hook-path", name: "read", arguments: {} },
    args: { path: "notes.txt" },
    context: {} as never,
  });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /outside the authorized workspace/);
  await session.close();
});

test("aborting a Pi turn interrupts a stalled chained tool hook", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-hook-abort-"));
  const fake = fakeSession(cwd);
  fake.session.agent.beforeToolCall = async () => new Promise<undefined>(() => {});
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const controller = new AbortController();
  const pending = fake.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "hook-abort", name: "read", arguments: {} },
    args: { path: "notes.txt" },
    context: {} as never,
  }, controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop|aborted/i);
  await session.close();
});

test("rejects native file tools that resolve through an outside symlink", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "cohub-pi-symlink-outside-"));
  await symlink(outside, join(cwd, "linked"), "dir");
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  const blocked = await fake.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "tool-path", name: "read", arguments: {} },
    args: { path: "linked/secrets.txt" },
    context: {} as never,
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /outside the authorized workspace/);
  await session.close();
});

test("fences Pi path aliases that would resolve outside the workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-path-alias-"));
  const fake = fakeSession(cwd);
  const session = new PiProviderSession(fake.session, { cwd, accessMode: "full_access" });
  for (const path of ["~/.ssh/id_rsa", "file:///etc/passwd", "@/etc/passwd"]) {
    const blocked = await fake.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { type: "toolCall", id: `alias-${path}`, name: "read", arguments: {} },
      args: { path },
      context: {} as never,
    });
    assert.equal(blocked?.block, true, path);
  }
  await session.close();
});

test("maps accepted Pi virtual workspace aliases before native tool execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-path-alias-map-"));
  const fake = fakeSession(cwd);
  const requests: Array<Record<string, unknown>> = [];
  const session = new PiProviderSession(fake.session, {
    cwd,
    accessMode: "full_access",
    authorizeTool: (request) => {
      requests.push(request.input);
      return true;
    },
  });
  const guard = fake.session.agent.beforeToolCall;
  assert.ok(guard);
  for (const alias of ["/workspace/notes.txt", "@/workspace/notes.txt", "file:///workspace/notes.txt"]) {
    const args = { path: alias };
    const result = await guard?.({
      assistantMessage: {} as never,
      toolCall: { type: "toolCall", id: `tool-${alias}`, name: "read", arguments: args },
      args,
      context: {} as never,
    });
    assert.equal(result, undefined);
    assert.equal(args.path, "notes.txt");
  }
  assert.deepEqual(requests.map((input) => input.path), ["notes.txt", "notes.txt", "notes.txt"]);
  await session.close();
});

test("emits Pi permission requests before awaiting authorization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-permission-pending-"));
  const fake = fakeSession(cwd);
  let resolveAuthorization!: (allowed: boolean) => void;
  let authorizationStarted!: () => void;
  const authorizationStartedPromise = new Promise<void>((resolve) => { authorizationStarted = resolve; });
  const session = new PiProviderSession(fake.session, {
    cwd,
    accessMode: "full_access",
    authorizeTool: () => {
      authorizationStarted();
      return new Promise<boolean>((resolve) => { resolveAuthorization = resolve; });
    },
  });
  fake.setPrompt(async () => {
    const result = await fake.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { type: "toolCall", id: "permission-tool", name: "read", arguments: {} },
      args: { path: "notes.txt" },
      context: {} as never,
    });
    assert.equal(result, undefined);
    const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    fake.setMessages([assistant]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const iterator = session.run({ text: "authorize" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");
  await authorizationStartedPromise;
  const permission = await iterator.next();
  assert.equal(permission.value?.kind, "permission.requested");
  assert.equal(permission.value?.payload.name, "read");
  resolveAuthorization(true);
  const terminal = await iterator.next();
  assert.equal(terminal.value?.kind, "turn.completed");
  assert.equal((await iterator.next()).done, true);
  await session.close();
});

test("canonicalizes a symlinked Pi cwd before creating the native session", async () => {
  const target = await mkdtemp(join(tmpdir(), "cohub-pi-cwd-target-"));
  const parent = await mkdtemp(join(tmpdir(), "cohub-pi-cwd-parent-"));
  const link = join(parent, "workspace-link");
  await symlink(target, link, "dir");
  const fake = fakeSession(target);
  let createdCwd = "";
  const manager = fake.session.sessionManager as never;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManagerFactory: {
      list: async () => [],
      open: () => manager,
      create: (cwd) => {
        createdCwd = cwd;
        return manager;
      },
    },
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd: link });
  assert.equal(createdCwd, target);
  await handle.close();
});

test("compares a symlinked Pi session manager cwd canonically", async () => {
  const target = await mkdtemp(join(tmpdir(), "cohub-pi-manager-cwd-target-"));
  const parent = await mkdtemp(join(tmpdir(), "cohub-pi-manager-cwd-parent-"));
  const link = join(parent, "workspace-link");
  await symlink(target, link, "dir");
  const fake = fakeSession(target);
  const manager = { getCwd: () => link };
  (fake.session as unknown as { sessionManager: typeof manager }).sessionManager = manager;
  const adapter = new PiProviderAdapter({
    modelRuntime: {} as ModelRuntime,
    sessionManager: manager as never,
    createAgentSession: async () => ({ session: fake.session }),
  });
  const handle = await adapter.open({ cwd: target });
  await handle.close();
});

test("cancels Pi turns from the session-level runtime signal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-session-signal-"));
  const fake = fakeSession(cwd);
  let resolvePrompt!: () => void;
  fake.setPrompt(() => new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  }));
  const controller = new AbortController();
  const session = new PiProviderSession(fake.session, { cwd, signal: controller.signal });
  const eventsPromise = collect(session.run({ text: "wait" }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("runtime shutdown"));
  resolvePrompt();
  const events = await eventsPromise;
  assert.equal(fake.abortCalls, 1);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.aborted, true);
  await session.close();
});

test("bounds cancellation when the native Pi abort never settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-abort-timeout-"));
  const fake = fakeSession(cwd);
  let resolvePrompt!: () => void;
  fake.setPrompt(() => new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  }));
  fake.setAbort(() => new Promise<void>(() => {}));
  const session = new PiProviderSession(fake.session, { cwd, cancelTimeoutMs: 20 });
  const iterator = session.run({ text: "hang" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");

  const cancelStart = Date.now();
  await session.cancel("test cancellation");
  assert.ok(Date.now() - cancelStart < 500);
  assert.equal(fake.abortCalls, 1);

  const closeStart = Date.now();
  await session.close();
  assert.ok(Date.now() - closeStart < 500);
  resolvePrompt();
});

test("observes late Pi agent_settled after a timed-out cancellation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-abort-settled-race-"));
  const fake = fakeSession(cwd);
  let resolvePrompt!: () => void;
  fake.setPrompt(() => new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  }));
  fake.setAbort(() => new Promise<void>(() => {}));
  const session = new PiProviderSession(fake.session, { cwd, cancelTimeoutMs: 20 });
  const iterator = session.run({ text: "race" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");

  await session.cancel("test cancellation");
  const failure = await iterator.next();
  assert.equal(failure.value?.kind, "turn.failed");
  assert.equal(failure.value?.payload.unknownOutcome, true);

  // The native operation can still deliver its settle signal after the
  // adapter has emitted the bounded cancellation failure.
  fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  resolvePrompt();
  const done = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<LocalRuntimeProviderEvent>>((_, reject) => setTimeout(() => reject(new Error("iterator did not finish")), 250)),
  ]);
  assert.equal(done.done, true);
  await session.close();
});

test("keeps the Pi turn fence while a timed-out iterator closes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-abort-iterator-fence-"));
  const fake = fakeSession(cwd);
  let resolvePrompt!: () => void;
  fake.setPrompt(() => new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  }));
  fake.setAbort(() => new Promise<void>(() => {}));
  const session = new PiProviderSession(fake.session, { cwd, cancelTimeoutMs: 20 });
  const iterator = session.run({ text: "hang" })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "turn.started");
  await iterator.return?.();
  const second = await collect(session.run({ text: "must wait" }));
  assert.equal(second.at(-1)?.kind, "turn.failed");
  assert.equal(second.at(-1)?.payload.code, "concurrent_turn");
  fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  resolvePrompt();
  await session.close();
});

test("waits for Pi retry attempts before emitting a terminal event", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-retry-"));
  const fake = fakeSession(cwd);
  fake.setPrompt(async () => {
    const failed = { role: "assistant", content: [{ type: "text", text: "temporary" }], stopReason: "error", errorMessage: "retry" };
    fake.emit({ type: "message_end", message: failed } as AgentSessionEvent);
    fake.emit({ type: "agent_end", messages: [failed], willRetry: true } as AgentSessionEvent);
    const final = { role: "assistant", content: [{ type: "text", text: "success" }], stopReason: "stop" };
    fake.emit({ type: "message_update", message: final, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "success", partial: final } } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.setMessages([failed, final]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "retry" }));
  assert.equal(events.filter((event) => event.kind === "turn.failed").length, 0);
  assert.equal(events.at(-1)?.kind, "turn.completed");
  assert.equal(events.at(-1)?.payload.output, "success");
  await session.close();
});

test("resets Pi usage between native retry attempts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cohub-pi-retry-usage-"));
  const fake = fakeSession(cwd);
  const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  fake.setPrompt(async () => {
    const failed = { role: "assistant", responseId: "retry-same", content: [{ type: "text", text: "temporary" }], usage, stopReason: "error", errorMessage: "retry" };
    fake.emit({ type: "message_end", message: failed } as AgentSessionEvent);
    fake.emit({ type: "agent_end", messages: [failed], willRetry: true } as AgentSessionEvent);
    const final = { role: "assistant", responseId: "retry-same", content: [{ type: "text", text: "success" }], usage, stopReason: "stop" };
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.setMessages([failed, final]);
    fake.emit({ type: "agent_settled" } as AgentSessionEvent);
  });
  const session = new PiProviderSession(fake.session, { cwd });
  const events = await collect(session.run({ text: "retry usage" }));
  assert.equal(events.filter((event) => event.kind === "usage").length, 2);
  assert.deepEqual(events.at(-1)?.payload.usage, usage);
  await session.close();
});
