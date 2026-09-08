import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import type {
  LocalProviderAdapter,
  LocalRuntimeCapabilities,
  LocalRuntimeCommand,
  LocalRuntimeEvent,
  LocalRuntimePromptInput,
  LocalRuntimeSessionHandle,
  LocalRuntimeSessionInput,
} from "@cohub/protocol";
import { LocalRuntimeEventSchema } from "@cohub/protocol";
import { runLocalRuntime } from "./runner.js";

const capabilities: LocalRuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  sessionFork: false,
  sessionCancel: true,
  permissionRequests: false,
  promptImages: false,
  nativeTools: true,
};

function command(overrides: Partial<LocalRuntimeCommand> = {}): LocalRuntimeCommand {
  return {
    version: 1,
    type: "command",
    commandId: "open-1",
    runtimeId: "runtime-1",
    spaceId: "space-1",
    runtimeSessionId: "runtime-session-1",
    cohubSessionId: "cohub-session-1",
    executionAttemptId: null,
    turnId: null,
    provider: "codex",
    providerSessionId: null,
    operation: "session.open",
    cwd: "/workspace",
    model: "gpt-5-codex",
    accessMode: "full_access",
    payload: { approvalPolicy: "never", modelReasoningEffort: "high" },
    connectionEpoch: 1,
    ...overrides,
  };
}

function lines(output: PassThrough): LocalRuntimeEvent[] {
  const events: LocalRuntimeEvent[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) events.push(LocalRuntimeEventSchema.parse(JSON.parse(line)));
    }
  });
  return events;
}

test("forwards native session options and publishes Codex's delayed id transition", async () => {
  let received: LocalRuntimeSessionInput | undefined;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture",
    capabilities,
    async open(input): Promise<LocalRuntimeSessionHandle> {
      received = input;
      return {
        providerSessionId: "",
        async *run(_prompt: LocalRuntimePromptInput) {
          yield { kind: "session.ready", payload: { providerSessionId: "native-thread-1" } };
          yield { kind: "turn.completed", payload: { stopReason: "end_turn" } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const turn = command({
    commandId: "turn-1",
    operation: "turn.start",
    providerSessionId: "pending:runtime-session-1",
    turnId: "turn-1",
    payload: { text: "hello" },
  });
  const input = Readable.from(`${JSON.stringify(command())}\n${JSON.stringify(turn)}\n`);
  const output = new PassThrough();
  const events = lines(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(received?.model, "gpt-5-codex");
  assert.equal(received?.accessMode, "full_access");
  assert.deepEqual(received?.payload, { approvalPolicy: "never", modelReasoningEffort: "high" });
  assert.equal(events[0]?.payload.provisional, true);
  assert.match(events[0]?.providerSessionId ?? "", /^pending:/);
  assert.equal(events[2]?.providerSessionId, "native-thread-1");
  assert.equal(events[2]?.kind, "session.ready");
  assert.equal(events[2]?.payload.provisional, false);
  const transitionMetadata = events[2]?.payload.metadata as Record<string, unknown> | undefined;
  assert.equal(transitionMetadata?.providerSessionTransition, true);
  assert.equal(events[3]?.providerSessionId, "native-thread-1");
  assert.equal(events[3]?.kind, "turn.completed");
});

test("requires the exact provisional id when a Codex thread is still lazy", async () => {
  let runCalls = 0;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture-lazy-codex",
    capabilities,
    async open(): Promise<LocalRuntimeSessionHandle> {
      return {
        providerSessionId: "",
        async *run() {
          runCalls += 1;
          yield { kind: "turn.completed" as const, payload: { stopReason: "end_turn" } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const input = Readable.from(`${JSON.stringify(command({ commandId: "exact-open" }))}\n${JSON.stringify(command({
    commandId: "wrong-pending-turn",
    operation: "turn.start",
    providerSessionId: "pending:another-runtime-session",
    turnId: "wrong-pending-turn",
    payload: { text: "should not run" },
  }))}\n`);
  const output = new PassThrough();
  const events = lines(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(events[0]?.providerSessionId, "pending:runtime-session-1");
  assert.equal(runCalls, 0);
  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.code, "provider_session_mismatch");
});

test("rejects a command from another execution attempt when the host channel is pinned", async () => {
  let opened = false;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture-attempt-fence",
    capabilities,
    async open(): Promise<LocalRuntimeSessionHandle> {
      opened = true;
      return {
        providerSessionId: "native-thread-attempt-fence",
        async *run() { yield { kind: "turn.completed", payload: {} }; },
        async cancel() {},
        async close() {},
      };
    },
  };
  const output = new PassThrough();
  await assert.rejects(
    runLocalRuntime({
      input: Readable.from(`${JSON.stringify(command({ executionAttemptId: "attempt-b" }))}\n`),
      output,
      adapters: { codex: adapter },
      executionAttemptId: "attempt-a",
      endOutput: true,
    }),
    /executionAttemptId does not match this host channel/,
  );
  assert.equal(opened, false);
});

test("rejects a provider attempting to replace a provisional id with another pending id", async () => {
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture-invalid-transition",
    capabilities,
    async open(): Promise<LocalRuntimeSessionHandle> {
      return {
        providerSessionId: "",
        async *run() {
          yield { kind: "session.ready" as const, payload: { providerSessionId: "pending:forged" } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const input = Readable.from(`${JSON.stringify(command({ commandId: "invalid-transition-open" }))}\n${JSON.stringify(command({
    commandId: "invalid-transition-turn",
    operation: "turn.start",
    providerSessionId: "pending:runtime-session-1",
    turnId: "invalid-transition-turn",
    payload: { text: "should fail" },
  }))}\n`);
  const output = new PassThrough();
  const events = lines(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(events.at(-1)?.kind, "turn.failed");
  assert.equal(events.at(-1)?.payload.code, "provider_session_changed");
  assert.equal(events.at(-1)?.payload.unknownOutcome, true);
});

test("keeps a read-only session from being widened by a later turn or resume", async () => {
  let runCalls = 0;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture-access-ceiling",
    capabilities,
    async open(): Promise<LocalRuntimeSessionHandle> {
      return {
        providerSessionId: "native-read-only",
        async *run() {
          runCalls += 1;
          yield { kind: "turn.completed", payload: {} };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const turn = command({
    commandId: "widen-turn",
    operation: "turn.start",
    providerSessionId: "native-read-only",
    accessMode: "full_access",
    turnId: "widen-turn",
    payload: { text: "must not run" },
  });
  const resume = command({
    commandId: "widen-resume",
    operation: "session.resume",
    providerSessionId: "native-read-only",
    accessMode: "full_access",
  });
  const input = Readable.from(`${JSON.stringify(command({ commandId: "read-only-open", accessMode: "read_only" }))}\n${JSON.stringify(turn)}\n${JSON.stringify(resume)}\n`);
  const output = new PassThrough();
  const events = lines(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, endOutput: true });

  assert.equal(runCalls, 0);
  const failures = events.filter((event) => event.payload.code === "access_mode_widening");
  assert.equal(failures.length, 2);
});

test("maps the virtual workspace and strips directory widening before SDK access", async () => {
  let received: LocalRuntimeSessionInput | undefined;
  let prompt: LocalRuntimePromptInput | undefined;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture",
    capabilities,
    async open(input): Promise<LocalRuntimeSessionHandle> {
      received = input;
      return {
        providerSessionId: "native-thread-2",
        async *run(value) {
          prompt = value;
          yield { kind: "turn.completed", payload: { stopReason: "end_turn" } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const root = "/tmp/cohub-runtime-fixture/project";
  const open = command({ payload: {
    cwd: "/workspace/subdir",
    additionalDirectories: ["/outside"],
  } });
  const turn = command({
    commandId: "turn-2",
    operation: "turn.start",
    providerSessionId: "native-thread-2",
    turnId: "turn-2",
    payload: {
      text: "hello",
      options: { cwd: "/workspace/subdir", additionalDirectories: ["/outside"] },
    },
  });
  const input = Readable.from(`${JSON.stringify(open)}\n${JSON.stringify(turn)}\n`);
  const output = new PassThrough();
  lines(output);
  await runLocalRuntime({ input, output, adapters: { codex: adapter }, workspaceRoot: root, endOutput: true });

  assert.equal(received?.cwd, `${root}`);
  assert.equal(received?.payload?.cwd, `${root}/subdir`);
  assert.equal(received?.payload?.additionalDirectories, undefined);
  assert.equal(prompt?.options?.cwd, `${root}/subdir`);
  assert.equal(prompt?.options?.additionalDirectories, undefined);
});

test("rejects a workspace path that escapes through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-runtime-root-"));
  const outside = await mkdtemp(join(tmpdir(), "cohub-runtime-outside-"));
  await mkdir(join(root, "safe"));
  await symlink(outside, join(root, "safe", "linked"), "dir");
  let opened = false;
  const adapter: LocalProviderAdapter = {
    provider: "codex",
    version: "fixture",
    capabilities,
    async open(): Promise<LocalRuntimeSessionHandle> {
      opened = true;
      return {
        providerSessionId: "native-thread-symlink",
        async *run() { yield { kind: "turn.completed", payload: {} }; },
        async cancel() {},
        async close() {},
      };
    },
  };
  await runLocalRuntime({
    input: Readable.from(`${JSON.stringify(command({ cwd: "/workspace/safe/linked" }))}\n`),
    output: new PassThrough(),
    adapters: { codex: adapter },
    workspaceRoot: root,
    endOutput: true,
  });
  assert.equal(opened, false);
});
