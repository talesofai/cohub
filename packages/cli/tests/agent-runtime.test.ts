import assert from "node:assert/strict";
import type { SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Command } from "commander";
import type { createClient } from "../src/client.js";
import {
  bundledRuntimeHostPath,
  registerAgentRuntime,
  startDetectedRuntimes,
} from "../src/commands/agent-runtime.js";
import type { DetectedProvider } from "../src/commands/provider-detection.js";

type RuntimeRecord = {
  id: string;
  spaceId: string;
  deviceId: string;
  replicaId: string;
  provider: DetectedProvider["provider"];
  displayName: string;
  status: string;
  connectionEpoch: number;
  lastSeenAt: string | null;
};

type RuntimeClient = ReturnType<typeof createClient>;

const provider = (value: DetectedProvider["provider"]): DetectedProvider => ({
  provider: value,
  displayName: value === "claude_code" ? "Claude Code" : value === "codex" ? "Codex" : "Pi",
});

const RECENT_RUNTIME_SEEN_AT = new Date().toISOString();

const runtime = (
  providerName: DetectedProvider["provider"],
  overrides: Partial<RuntimeRecord> = {},
): RuntimeRecord => ({
  id: `${providerName}-runtime`,
  spaceId: "space-1",
  deviceId: "device-1",
  replicaId: "replica-1",
  provider: providerName,
  displayName: `${providerName} local runtime`,
  status: "offline",
  connectionEpoch: 1,
  lastSeenAt: null,
  ...overrides,
});

const fakeClient = (input: {
  runtimes?: RuntimeRecord[];
  register?: (spaceId: string, body: Record<string, unknown>) => Promise<RuntimeRecord>;
}) => {
  const registrations: Array<{ spaceId: string; body: Record<string, unknown> }> = [];
  const client = {
    localAgent: {
      listRuntimes: async (_spaceId: string) => ({ runtimes: input.runtimes ?? [] }),
      registerRuntime: async (spaceId: string, body: Record<string, unknown>) => {
        registrations.push({ spaceId, body });
        if (input.register) return input.register(spaceId, body);
        const current = input.runtimes?.find((item) => item.provider === body.provider && item.status !== "revoked");
        if (current && (current.replicaId === body.replicaId || ["ready", "busy"].includes(current.status))) {
          return current;
        }
        return runtime(body.provider as DetectedProvider["provider"], { id: `${String(body.provider)}-new` });
      },
    },
  };
  return {
    client: client as unknown as RuntimeClient,
    registrations,
  };
};

class FakeChild extends EventEmitter {
  pid = 4242;
  unrefCalls = 0;

  unref() {
    this.unrefCalls += 1;
    return this;
  }
}

const fakeSpawn = (calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>) => {
  return ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return new FakeChild();
  }) as unknown as typeof spawn;
};

test("resolves the runtime host from the installed CLI package", () => {
  const expected = fileURLToPath(new URL("../bin/cohub-agent-runtime.js", import.meta.url));
  assert.equal(bundledRuntimeHostPath(), expected);
});

test("exposes only the native runtime lifecycle commands", () => {
  const program = new Command("cohub");
  registerAgentRuntime(program);

  const agent = program.commands.find((command) => command.name() === "agent");
  assert.ok(agent);
  assert.deepEqual(agent.commands.map((command) => command.name()), ["runtime", "doctor"]);

  const runtimeCommand = agent.commands.find((command) => command.name() === "runtime");
  assert.ok(runtimeCommand);
  assert.deepEqual(runtimeCommand.commands.map((command) => command.name()), ["get", "list", "start", "revoke"]);

  const start = runtimeCommand.commands.find((command) => command.name() === "start");
  assert.ok(start);
  assert.deepEqual(start.registeredArguments.map((argument) => argument.name()), ["spaceId"]);
  assert.equal(start.options.find((option) => option.long === "--root")?.mandatory, true);
  assert.equal(start.options.some((option) => option.long === "--runtime-id"), false);
  assert.equal(start.options.some((option) => option.long === "--provider"), false);
  assert.equal(start.options.some((option) => option.long === "--relay"), false);
  assert.equal(start.options.some((option) => option.long === "--provider-command"), false);
  assert.equal(start.options.some((option) => option.long === "--mode"), false);
});

test("rejects missing roots and legacy start arguments", async () => {
  const parse = async (argv: string[]) => {
    const program = new Command("cohub");
    program.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerAgentRuntime(program);
    await program.parseAsync(["node", "cohub", ...argv]);
  };

  await assert.rejects(parse(["agent", "runtime", "start", "space-1"]), /required option '--root <path>' not specified/);
  await assert.rejects(
    parse(["agent", "runtime", "start", "space-1", "replica-1", "codex", "--root", "/work/project"]),
    /too many arguments/,
  );
  await assert.rejects(
    parse(["agent", "runtime", "start", "space-1", "--root", "/work/project", "--runtime-id", "runtime-1"]),
    /unknown option '--runtime-id'/,
  );
});

test("starts every detected provider in order and sends native host arguments", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client, registrations } = fakeClient({});
  const result = await startDetectedRuntimes({
    client,
    binary: "/tmp/cohub-locald",
    dataDir: "/tmp/cohub-data",
    spaceId: "space-1",
    root: "/work/project",
    deviceId: "device-1",
    replicaId: "replica-1",
    providers: [provider("codex"), provider("claude_code"), provider("pi")],
    relay: "wss://relay.test/runtime",
    providerCommand: "/tmp/cohub-agent-runtime.js",
    spawnProcess: fakeSpawn(calls),
  });

  assert.deepEqual(result.runtimes.map((item) => [item.provider, item.state, item.runtimeId]), [
    ["codex", "started", "codex-new"],
    ["claude_code", "started", "claude_code-new"],
    ["pi", "started", "pi-new"],
  ]);
  assert.equal(result.waits.length, 0);
  assert.deepEqual(registrations.map((item) => item.body), [
    {
      deviceId: "device-1",
      replicaId: "replica-1",
      provider: "codex",
      displayName: "Codex local runtime",
      protocolVersion: 1,
    },
    {
      deviceId: "device-1",
      replicaId: "replica-1",
      provider: "claude_code",
      displayName: "Claude Code local runtime",
      protocolVersion: 1,
    },
    {
      deviceId: "device-1",
      replicaId: "replica-1",
      provider: "pi",
      displayName: "Pi local runtime",
      protocolVersion: 1,
    },
  ]);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 14)), [
    ["runtime", "--data-dir", "/tmp/cohub-data", "--space-id", "space-1", "--runtime-id", "codex-new", "--replica-id", "replica-1", "--provider", "codex", "--root", "/work/project", "--relay"],
    ["runtime", "--data-dir", "/tmp/cohub-data", "--space-id", "space-1", "--runtime-id", "claude_code-new", "--replica-id", "replica-1", "--provider", "claude_code", "--root", "/work/project", "--relay"],
    ["runtime", "--data-dir", "/tmp/cohub-data", "--space-id", "space-1", "--runtime-id", "pi-new", "--replica-id", "replica-1", "--provider", "pi", "--root", "/work/project", "--relay"],
  ]);
  assert.equal(calls.every((call) => call.args.includes("wss://relay.test/runtime")), true);
  assert.equal(calls.every((call) => call.args.includes("/tmp/cohub-agent-runtime.js")), true);
});

test("reuses connected runtimes and starts offline or errored runtimes after idempotent registration", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client, registrations } = fakeClient({
    runtimes: [
      runtime("codex", { id: "codex-ready", status: "ready", lastSeenAt: RECENT_RUNTIME_SEEN_AT }),
      runtime("claude_code", { id: "claude-offline", status: "offline" }),
      runtime("pi", { id: "pi-error", status: "error" }),
    ],
  });
  const result = await startDetectedRuntimes({
    client,
    binary: "/tmp/cohub-locald",
    dataDir: "/tmp/cohub-data",
    spaceId: "space-1",
    root: "/work/project",
    deviceId: "device-1",
    replicaId: "replica-1",
    providers: [provider("codex"), provider("claude_code"), provider("pi")],
    relay: "wss://relay.test/runtime",
    spawnProcess: fakeSpawn(calls),
  });

  assert.deepEqual(result.runtimes, [
    { provider: "codex", runtimeId: "codex-ready", state: "already_running", pid: null, relay: "wss://relay.test/runtime" },
    { provider: "claude_code", runtimeId: "claude-offline", state: "started", pid: 4242, relay: "wss://relay.test/runtime" },
    { provider: "pi", runtimeId: "pi-error", state: "started", pid: 4242, relay: "wss://relay.test/runtime" },
  ]);
  assert.equal(registrations.length, 3);
  assert.equal(calls.length, 2);
});

test("does not reuse an active-looking runtime whose heartbeat is stale", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client } = fakeClient({
    runtimes: [runtime("codex", {
      id: "codex-stale",
      status: "ready",
      lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
    })],
  });
  const result = await startDetectedRuntimes({
    client,
    binary: "/tmp/cohub-locald",
    dataDir: "/tmp/cohub-data",
    spaceId: "space-1",
    root: "/work/project",
    deviceId: "device-1",
    replicaId: "replica-1",
    providers: [provider("codex")],
    relay: "wss://relay.test/runtime",
    spawnProcess: fakeSpawn(calls),
  });

  assert.deepEqual(result.runtimes.map((item) => [item.runtimeId, item.state]), [["codex-stale", "started"]]);
  assert.equal(calls.length, 1);
});

test("re-registers revoked runtimes and migrates offline runtimes to the attached replica", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client, registrations } = fakeClient({
    runtimes: [
      runtime("codex", { id: "codex-revoked", status: "revoked" }),
      runtime("claude_code", { id: "claude-old-replica", status: "offline", replicaId: "replica-old" }),
    ],
  });
  const result = await startDetectedRuntimes({
    client,
    binary: "/tmp/cohub-locald",
    dataDir: "/tmp/cohub-data",
    spaceId: "space-1",
    root: "/work/project",
    deviceId: "device-1",
    replicaId: "replica-1",
    providers: [provider("codex"), provider("claude_code")],
    relay: "wss://relay.test/runtime",
    spawnProcess: fakeSpawn(calls),
  });

  assert.deepEqual(registrations.map((item) => item.body.replicaId), ["replica-1", "replica-1"]);
  assert.deepEqual(result.runtimes.map((item) => item.runtimeId), ["codex-new", "claude_code-new"]);
  assert.equal(calls.length, 2);
});

test("reports a connected runtime bound to another replica instead of starting it", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client, registrations } = fakeClient({
    runtimes: [runtime("codex", { id: "codex-connected-old", status: "ready", replicaId: "replica-old", lastSeenAt: RECENT_RUNTIME_SEEN_AT })],
    register: async () => {
      throw new Error("runtime is already connected to another workspace replica");
    },
  });

  await assert.rejects(
    startDetectedRuntimes({
      client,
      binary: "/tmp/cohub-locald",
      dataDir: "/tmp/cohub-data",
      spaceId: "space-1",
      root: "/work/project",
      deviceId: "device-1",
      replicaId: "replica-1",
      providers: [provider("codex")],
      relay: "wss://relay.test/runtime",
      spawnProcess: fakeSpawn(calls),
    }),
    /No local runtimes could be registered.*already connected/,
  );
  assert.equal(registrations.length, 1);
  assert.equal(calls.length, 0);
});

test("does not create or start anything when no providers are detected", async () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const { client, registrations } = fakeClient({});
  await assert.rejects(
    startDetectedRuntimes({
      client,
      binary: "/tmp/cohub-locald",
      dataDir: "/tmp/cohub-data",
      spaceId: "space-1",
      root: "/work/project",
      deviceId: "device-1",
      replicaId: "replica-1",
      providers: [],
      spawnProcess: fakeSpawn(calls),
    }),
    /No local runtimes were detected/,
  );
  assert.equal(registrations.length, 0);
  assert.equal(calls.length, 0);
});
