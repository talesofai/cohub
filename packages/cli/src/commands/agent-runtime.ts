import { spawn as nodeSpawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  isLocalRuntimeHeartbeatFresh,
  resolveApiBaseUrl,
  resolveWebsocketUrl,
  type LocalRuntimeRecord,
} from "@neta-art/cohub";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { detectLocalProviders, providerDisplayName, type DetectedProvider } from "./provider-detection.js";
import { ensureWorkspaceReplica, LocaldUnavailableError } from "./local-workspace.js";
import { resolveLocaldBinary } from "./locald-binary.js";

type Provider = DetectedProvider["provider"];

type StartedRuntime = {
  provider: Provider;
  runtimeId: string;
  state: "started" | "already_running";
  pid: number | null;
  relay: string;
};

const runtimeRelayUrl = () => {
  const explicit = process.env.COHUB_RUNTIME_RELAY_URL?.trim();
  if (explicit) return explicit;
  return resolveWebsocketUrl({ url: process.env.COHUB_WS_URL }).replace(/\/ws$/, "/runtime/relay");
};

/**
 * The runtime host ships inside the CLI tarball. Resolve it relative to this
 * module so a global npm install does not depend on the caller's PATH.
 */
export const bundledRuntimeHostPath = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/cohub-agent-runtime.js");

function startLocalRuntime(input: {
  binary: string;
  dataDir: string;
  runtime: LocalRuntimeRecord;
  root: string;
  relay?: string;
  providerCommand?: string;
  foreground?: boolean;
  spawnProcess?: typeof nodeSpawn;
}) {
  const relay = input.relay?.trim() || runtimeRelayUrl();
  const providerCommand = input.providerCommand?.trim() || bundledRuntimeHostPath();
  const foreground = input.foreground === true;
  const child = (input.spawnProcess ?? nodeSpawn)(input.binary, [
    "runtime",
    "--data-dir", input.dataDir,
    "--space-id", input.runtime.spaceId,
    "--runtime-id", input.runtime.id,
    "--replica-id", input.runtime.replicaId,
    "--provider", input.runtime.provider,
    "--root", input.root,
    "--relay", relay,
    "--provider-command", providerCommand,
  ], {
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    env: {
      ...process.env,
      COHUB_API_URL: resolveApiBaseUrl({}),
      COHUB_LOCALD_DATA_DIR: input.dataDir,
      COHUB_LOCAL_AGENT_DEVICE_ID: input.runtime.deviceId,
      COHUB_NODE_EXECUTABLE: process.execPath,
    },
  });
  if (!foreground) {
    // Detached children can fail after the parent command has returned. Keep
    // the error event handled so a missing executable does not crash the CLI.
    child.once("error", () => undefined);
    child.unref();
    return { pid: child.pid ?? null, relay, wait: null as Promise<number | null> | null };
  }
  const wait = new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code));
  });
  return { pid: child.pid ?? null, relay, wait };
}

/** Start or reuse all provider registrations for one attached workspace. */
export async function startDetectedRuntimes(input: {
  client: ReturnType<typeof createClient>;
  binary: string;
  dataDir: string;
  spaceId: string;
  root: string;
  deviceId: string;
  replicaId: string;
  providers: readonly DetectedProvider[];
  relay?: string;
  providerCommand?: string;
  foreground?: boolean;
  spawnProcess?: typeof nodeSpawn;
}): Promise<{ runtimes: StartedRuntime[]; waits: Array<Promise<number | null>> }> {
  const registrations: Array<{ runtime: LocalRuntimeRecord; provider: Provider }> = [];
  const failures: string[] = [];

  for (const detected of input.providers) {
    try {
      // Registration is idempotent and intentionally runs for every detected
      // provider, moving offline registrations to the current replica.
      const runtime = await input.client.localAgent.registerRuntime(input.spaceId, {
        deviceId: input.deviceId,
        replicaId: input.replicaId,
        provider: detected.provider,
        displayName: `${detected.displayName} local runtime`,
        protocolVersion: 1,
      });
      if (runtime.replicaId !== input.replicaId) throw new Error("runtime is bound to a different workspace replica");
      if (runtime.status === "revoked") throw new Error("runtime registration is revoked");
      registrations.push({ runtime, provider: detected.provider });
    } catch (cause) {
      failures.push(`${detected.displayName}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (registrations.length === 0) {
    throw new Error(failures.length > 0
      ? `No local runtimes could be registered. ${failures.join("; ")}`
      : "No local runtimes were detected.");
  }
  // Do not launch a subset of providers and then report failure. A detached
  // child would otherwise survive a failed `start` command with no reliable
  // handle for the caller to clean it up.
  if (failures.length > 0) {
    throw new Error(`Some local runtimes could not be registered: ${failures.join("; ")}`);
  }

  const runtimes: StartedRuntime[] = [];
  const waits: Array<Promise<number | null>> = [];
  for (const { runtime, provider } of registrations) {
    const alreadyRunning = ["ready", "busy"].includes(runtime.status)
      && isLocalRuntimeHeartbeatFresh(runtime.lastSeenAt);
    if (alreadyRunning) {
      runtimes.push({ provider, runtimeId: runtime.id, state: "already_running", pid: null, relay: input.relay?.trim() || runtimeRelayUrl() });
      continue;
    }
    const started = startLocalRuntime({
      binary: input.binary,
      dataDir: input.dataDir,
      runtime,
      root: input.root,
      relay: input.relay,
      providerCommand: input.providerCommand,
      foreground: input.foreground,
      spawnProcess: input.spawnProcess,
    });
    runtimes.push({ provider, runtimeId: runtime.id, state: "started", pid: started.pid, relay: started.relay });
    if (started.wait) waits.push(started.wait);
  }
  return { runtimes, waits };
}

async function waitForReplicaReady(client: ReturnType<typeof createClient>, spaceId: string, replicaId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (Date.now() < deadline) {
    const state = await client.localAgent.state(spaceId, replicaId);
    const replica = state.replica as { status?: string; appliedSnapshotId?: string | null } | null;
    const workspace = state.workspace as { status?: string; canonicalSnapshotId?: string | null } | null;
    if (replica?.status === "conflicted" || workspace?.status === "conflicted") throw new Error("Workspace synchronization has a conflict; resolve it before starting a runtime.");
    if (replica?.status === "ready" && workspace?.status === "ready" && workspace.canonicalSnapshotId && replica.appliedSnapshotId === workspace.canonicalSnapshotId) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    delay = Math.min(delay * 2, 5_000);
  }
  throw new Error("Workspace is still synchronizing. Retry `cohub agent runtime start` when the replica is ready.");
}

async function commandVersion(command: string, nodeScript = false): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = nodeScript
      ? nodeSpawn(process.execPath, [command, "--version"], { stdio: ["ignore", "pipe", "pipe"] })
      : nodeSpawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, 3_000);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? Buffer.concat(output).toString("utf8").trim() || "unknown" : null));
  });
}

export function registerAgentRuntime(program: Command): void {
  const agent = program.command("agent").description("Local agent runtimes");
  const runtime = agent.command("runtime").description("Manage local agent runtimes");

  runtime
    .command("get <spaceId> <runtimeId>")
    .description("Show a registered local runtime")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, runtimeId: string, opts: { json?: boolean }) => {
      try {
        const result = await createClient().localAgent.getRuntime(spaceId, runtimeId);
        if (jsonRequested(opts)) return outJson(result);
        table([result], [
          { key: "id", label: "Runtime" },
          { key: "provider", label: "Provider" },
          { key: "replicaId", label: "Replica" },
          { key: "status", label: "Status" },
          { key: "connectionEpoch", label: "Epoch" },
          { key: "lastError", label: "Error" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  runtime
    .command("list <spaceId>")
    .description("List registered local runtimes")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, opts: { json?: boolean }) => {
      try {
        const result = await createClient().localAgent.listRuntimes(spaceId);
        if (jsonRequested(opts)) return outJson(result);
        table(result.runtimes, [
          { key: "id", label: "Runtime" },
          { key: "provider", label: "Provider" },
          { key: "displayName", label: "Name" },
          { key: "status", label: "Status" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  runtime
    .command("start <spaceId>")
    .description("Attach a workspace and start every detected local runtime")
    .requiredOption("--root <path>", "Local workspace root")
    .option("--name <name>", "Device or workspace display name")
    .option("--data-dir <path>", "locald state directory")
    .option("--foreground", "Keep runtimes attached to this terminal")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, opts: { root: string; name?: string; dataDir?: string; foreground?: boolean; json?: boolean }) => {
      const root = resolve(opts.root);
      try {
        const rootInfo = await stat(root).catch(() => null);
        if (!rootInfo?.isDirectory()) return error("Invalid workspace root", `${root} is not a directory.`);
        const providers = await detectLocalProviders();
        if (providers.length === 0) return error("No local runtimes detected", "Sign in to Codex, Claude Code, or Pi on this machine, then retry.");
        const prepared = await ensureWorkspaceReplica({
          client: createClient(),
          spaceId,
          root,
          options: { dataDir: opts.dataDir, name: opts.name, automatic: true },
        });
        const replicaId = String(prepared.attached.replica.id);
        await waitForReplicaReady(createClient(), spaceId, replicaId);
        const client = createClient();
        const started = await startDetectedRuntimes({
          client,
          binary: prepared.binary,
          dataDir: prepared.dataDir,
          spaceId,
          root: prepared.root,
          deviceId: prepared.device.id,
          replicaId,
          providers,
          foreground: opts.foreground,
        });
        const result = {
          spaceId,
          root: prepared.root,
          deviceId: prepared.device.id,
          replicaId,
          providers: providers.map((provider) => provider.provider),
          runtimes: started.runtimes,
        };
        if (jsonRequested(opts)) outJson(result);
        else {
          ok(`Local runtimes ${opts.foreground ? "running" : "started"}`);
          console.log(`  Space:   ${spaceId}`);
          console.log(`  Root:    ${prepared.root}`);
          console.log(`  Replica: ${replicaId}`);
          for (const item of started.runtimes) console.log(`  ${providerDisplayName(item.provider)}: ${item.state} (${item.runtimeId})`);
        }
        if (opts.foreground && started.waits.length > 0) {
          const codes = await Promise.all(started.waits);
          const failed = codes.find((code) => code !== 0);
          if (failed !== undefined) return error("Local runtime stopped", `Exit code: ${failed ?? "unknown"}`);
        }
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  runtime
    .command("revoke <spaceId> <runtimeId>")
    .description("Revoke a local runtime")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, runtimeId: string, opts: { json?: boolean }) => {
      try {
        const result = await createClient().localAgent.revokeRuntime(spaceId, runtimeId);
        if (jsonRequested(opts)) return outJson(result);
        ok("Local runtime revoked");
      } catch (cause) {
        handleHttp(cause);
      }
    });

  agent
    .command("doctor")
    .description("Check locald, the native runtime host, and local credentials")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const binary = await resolveLocaldBinary();
        const binaryInfo = await stat(binary);
        await access(binary, constants.X_OK);
        const hostPath = bundledRuntimeHostPath();
        const hostVersion = await commandVersion(hostPath, true);
        const detected = await detectLocalProviders();
        const detectedSet = new Set(detected.map((provider) => provider.provider));
        const rows = (["codex", "claude_code", "pi"] as const).map((provider) => ({
          provider: providerDisplayName(provider),
          configured: detectedSet.has(provider),
          host: hostVersion ? `bundled ${hostVersion}` : "bundled host missing",
        }));
        const result = {
          locald: { binary, executable: binaryInfo.isFile() },
          runtimeHost: { path: hostPath, available: hostVersion !== null, version: hostVersion },
          providers: rows,
        };
        if (jsonRequested(opts)) return outJson(result);
        table(rows, [
          { key: "provider", label: "Provider" },
          { key: "configured", label: "Configured" },
          { key: "host", label: "Runtime host" },
        ]);
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });
}
