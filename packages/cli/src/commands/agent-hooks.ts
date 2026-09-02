import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { resolveApiBaseUrl, resolveWebsocketUrl } from "@neta-art/cohub";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, spinner, table } from "../output.js";
import {
  installLocaldBinary,
  LocaldUnavailableError,
  localdBinaryCachePath,
  resolveLocaldBinary,
  updateLocaldBinary,
} from "./locald-binary.js";

type Provider = "pi" | "claude_code" | "codex";

type RuntimeRecord = {
  id: string;
  spaceId: string;
  deviceId: string;
  replicaId: string | null;
  provider: Provider;
  displayName: string;
  status: string;
  connectionEpoch: number;
};

const runtimeRelayUrl = () => {
  const explicit = process.env.COHUB_RUNTIME_RELAY_URL?.trim();
  if (explicit) return explicit;
  return resolveWebsocketUrl({ url: process.env.COHUB_WS_URL }).replace(/\/ws$/, "/runtime/relay");
};

type HookHandler = {
  type: "command";
  command: string;
  args?: string[];
  commandWindows?: string;
  timeout?: number;
  async?: boolean;
};
type HookGroup = { matcher?: string; hooks: HookHandler[] };
type HookSettings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

const PROVIDER_ALIASES: Record<string, Provider> = {
  pi: "pi",
  claude: "claude_code",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  codex: "codex",
};

const HOOK_EVENTS: Record<Exclude<Provider, "pi">, string[]> = {
  claude_code: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "PreCompact", "PostCompact", "SessionEnd"],
  codex: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "PostCompact", "SessionEnd"],
};

const parseProvider = (value: string): Provider => {
  const provider = PROVIDER_ALIASES[value.trim().toLowerCase()];
  if (!provider) return error("Unknown provider", "Use pi, claude-code, or codex.");
  return provider;
};

const providerDisplayName = (provider: Provider) => provider === "claude_code" ? "Claude Code" : provider === "pi" ? "Pi" : "Codex";
const providerAdapterCommand = (provider: Provider) => provider === "pi" ? "pi-acp" : provider === "codex" ? "codex-acp" : "claude-agent-acp";
const providerConfigPath = (provider: Exclude<Provider, "pi">) => provider === "claude_code"
  ? join(homedir(), ".claude", "settings.json")
  : join(homedir(), ".codex", "hooks.json");

async function readJsonObject(path: string): Promise<HookSettings> {
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return "{}";
    throw cause;
  });
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as HookSettings;
}

async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.cohub-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const isCohubHandler = (handler: unknown, provider: Provider, binary?: string) => {
  if (!handler || typeof handler !== "object") return false;
  const value = handler as { args?: unknown; command?: unknown };
  if (Array.isArray(value.args)) {
    return value.args.includes("hook") && value.args.includes("--provider") && value.args.includes(provider);
  }
  return typeof value.command === "string"
    && (!binary || value.command.includes(binary))
    && value.command.includes("--provider")
    && value.command.includes(provider);
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const windowsQuote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

async function installCommandHooks(provider: Exclude<Provider, "pi">, binary: string) {
  const path = providerConfigPath(provider);
  const providerVersion = await commandVersion(provider === "claude_code" ? "claude" : "codex") ?? "unknown";
  const settings = await readJsonObject(path);
  const hooks = settings.hooks && typeof settings.hooks === "object" ? { ...settings.hooks } : {};
  for (const event of HOOK_EVENTS[provider]) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const retained = existing.map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isCohubHandler(handler, provider, binary)) : [],
    })).filter((group) => group.hooks.length > 0);
    const args = ["hook", "--provider", provider, "--provider-version", providerVersion, "--event", event];
    const handler: HookHandler = provider === "claude_code"
      ? {
          type: "command",
          command: binary,
          args,
          timeout: event === "UserPromptSubmit" ? 1 : 3,
          ...(event === "UserPromptSubmit" ? {} : { async: true }),
        }
      : {
          type: "command",
          command: [shellQuote(binary), ...args.map(shellQuote)].join(" "),
          commandWindows: [windowsQuote(binary), ...args.map(windowsQuote)].join(" "),
          timeout: event === "UserPromptSubmit" ? 1 : 3,
          ...(event === "UserPromptSubmit" ? {} : { async: true }),
        };
    hooks[event] = [...retained, { hooks: [handler] }];
  }
  await writePrivateJson(path, { ...settings, hooks });
  return path;
}

function piExtensionSource(binary: string, providerVersion: string) {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const binary = ${JSON.stringify(binary)};
const providerVersion = ${JSON.stringify(providerVersion)};
type ActiveTurn = {
  executionAttemptId: string;
  nativeSessionId: string;
  nativeTurnId: string;
  prompt: string;
  cwd: string;
  messages: unknown[];
};
let active: ActiveTurn | null = null;

const runLocald = (args: string[], input?: unknown, capture = false) => new Promise<string>((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ["pipe", capture ? "pipe" : "ignore", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", reject);
  child.once("close", (code) => code === 0
    ? resolve(Buffer.concat(stdout).toString("utf8"))
    : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "cohub-locald exited with " + code)));
  child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
});

const emit = async (event: string, ctx: { cwd: string }, payload: Record<string, unknown>, attemptId?: string) => {
  await runLocald([
    "hook", "--provider", "pi", "--provider-version", providerVersion, "--event", event, "--cwd", ctx.cwd,
    ...(attemptId ? ["--execution-attempt-id", attemptId] : []),
  ], payload);
};

export default function cohubLocalAgent(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    await emit("session_start", ctx, {
      sessionId: ctx.sessionManager.getSessionId(),
      reason: event.reason,
    }).catch(() => undefined);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (event.streamingBehavior) {
      ctx.ui.notify("Finish the active local turn before another CoHub handoff.", "warning");
      return { action: "handled" as const };
    }
    try {
      const raw = await runLocald(["preflight", "--cwd", ctx.cwd], undefined, true);
      const permit = JSON.parse(raw) as { executionAttemptId?: string; ok?: boolean };
      if (!permit.ok || !permit.executionAttemptId) throw new Error("Workspace handoff is not ready.");
      active = {
        executionAttemptId: permit.executionAttemptId,
        nativeSessionId: ctx.sessionManager.getSessionId(),
        nativeTurnId: randomUUID(),
        prompt: event.text,
        cwd: ctx.cwd,
        messages: [],
      };
      await emit("prompt_submitted", ctx, {
        sessionId: active.nativeSessionId,
        turnId: active.nativeTurnId,
        prompt: event.text,
      }, active.executionAttemptId);
      return { action: "continue" as const };
    } catch (cause) {
      ctx.ui.notify(cause instanceof Error ? cause.message : "Workspace handoff is not ready.", "warning");
      return { action: "handled" as const };
    }
  });

  pi.on("agent_end", async (event) => {
    if (active) active.messages.push(...event.messages);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!active) return;
    await emit("tool_started", ctx, {
      sessionId: active.nativeSessionId,
      turnId: active.nativeTurnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: event.args,
    }, active.executionAttemptId).catch(() => undefined);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!active) return;
    await emit("tool_finished", ctx, {
      sessionId: active.nativeSessionId,
      turnId: active.nativeTurnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      result: event.result,
    }, active.executionAttemptId).catch(() => undefined);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const turn = active;
    if (!turn) return;
    active = null;
    try {
      await runLocald(["collect-pi", "--cwd", turn.cwd], {
        executionAttemptId: turn.executionAttemptId,
        nativeSessionId: turn.nativeSessionId,
        nativeTurnId: turn.nativeTurnId,
        providerVersion,
        prompt: turn.prompt,
        messages: turn.messages,
      });
      await emit("turn_stopped", ctx, {
        sessionId: turn.nativeSessionId,
        turnId: turn.nativeTurnId,
      }, turn.executionAttemptId);
    } catch (cause) {
      ctx.ui.notify(cause instanceof Error ? cause.message : "Failed to spool CoHub mirror.", "warning");
      await emit("turn_failed", ctx, {
        sessionId: turn.nativeSessionId,
        turnId: turn.nativeTurnId,
      }, turn.executionAttemptId).catch(() => undefined);
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    await emit("session_compacted", ctx, {
      sessionId: ctx.sessionManager.getSessionId(),
      reason: event.reason,
    }, active?.executionAttemptId).catch(() => undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await emit("session_ended", ctx, {
      sessionId: ctx.sessionManager.getSessionId(),
      turnId: active?.nativeTurnId,
    }, active?.executionAttemptId).catch(() => undefined);
  });
}
`;
}

async function installPiExtension(binary: string) {
  const path = join(homedir(), ".pi", "agent", "extensions", "cohub-local-agent.ts");
  const providerVersion = await commandVersion("pi") ?? "unknown";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, piExtensionSource(binary, providerVersion), { mode: 0o600 });
  return path;
}

const localdDataDir = (value?: string) => value?.trim() || process.env.COHUB_LOCALD_DATA_DIR?.trim() || join(homedir(), ".local", "share", "cohub", "locald");

async function runLocaldCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolvePromise(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `cohub-locald exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureLocaldDaemon(binary: string, dataDir: string, deviceId: string) {
  try {
    const status = JSON.parse(await runLocaldCommand(binary, ["status", "--data-dir", dataDir])) as { ok?: boolean };
    if (status.ok) return;
  } catch {
    // Start the daemon below.
  }
  const child = spawn(binary, ["daemon", "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COHUB_API_URL: resolveApiBaseUrl({}),
      COHUB_LOCAL_AGENT_DEVICE_ID: deviceId,
      COHUB_LOCALD_DATA_DIR: dataDir,
    },
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
    try {
      const status = JSON.parse(await runLocaldCommand(binary, ["status", "--data-dir", dataDir])) as { ok?: boolean };
      if (status.ok) return;
    } catch {
      // Keep polling during bounded startup.
    }
  }
  throw new Error("cohub-locald did not become ready");
}

function startLocalAcpRuntime(input: {
  binary: string;
  dataDir: string;
  runtime: RuntimeRecord;
  root: string;
  relay?: string;
  providerCommand?: string;
  foreground?: boolean;
}) {
  if (!input.runtime.replicaId) throw new Error("runtime has no workspace replica");
  const relay = input.relay?.trim() || runtimeRelayUrl();
  const foreground = input.foreground === true;
  const child = spawn(input.binary, [
    "runtime",
    "--data-dir", input.dataDir,
    "--space-id", input.runtime.spaceId,
    "--runtime-id", input.runtime.id,
    "--replica-id", input.runtime.replicaId,
    "--provider", input.runtime.provider,
    "--root", input.root,
    "--relay", relay,
    ...(input.providerCommand?.trim() ? ["--provider-command", input.providerCommand.trim()] : []),
  ], {
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    env: {
      ...process.env,
      COHUB_API_URL: resolveApiBaseUrl({}),
      COHUB_LOCALD_DATA_DIR: input.dataDir,
      COHUB_LOCAL_AGENT_DEVICE_ID: input.runtime.deviceId,
    },
  });
  if (!foreground) {
    child.unref();
    return { pid: child.pid ?? null, relay, wait: null as Promise<number | null> | null };
  }
  const wait = new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code));
  });
  return { pid: child.pid ?? null, relay, wait };
}

async function commandVersion(command: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
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

async function hookInstalled(provider: Provider, binary: string) {
  if (provider === "pi") {
    const path = join(homedir(), ".pi", "agent", "extensions", "cohub-local-agent.ts");
    const content = await readFile(path, "utf8").catch(() => "");
    return content.includes(binary) && content.includes("collect-pi");
  }
  const settings = await readJsonObject(providerConfigPath(provider));
  return Object.values(settings.hooks ?? {}).flat().some((group) => group.hooks?.some((handler) => isCohubHandler(handler, provider, binary)));
}

export function registerAgentHooks(program: Command): void {
  const agent = program.command("agent").description("Local native agent integration");
  const hooks = agent.command("hooks").description("Install provider-native hooks");

  hooks
    .command("install <provider>")
    .description("Install user-scoped CoHub hooks for Pi, Claude Code, or Codex")
    .option("--json", "Output as JSON")
    .action(async (providerInput: string, opts: { json?: boolean }) => {
      const provider = parseProvider(providerInput);
      try {
        const binary = await resolveLocaldBinary();
        const path = provider === "pi" ? await installPiExtension(binary) : await installCommandHooks(provider, binary);
        const result = { provider, path, binary };
        if (jsonRequested(opts)) return outJson(result);
        ok(`${providerDisplayName(provider)} hooks installed`);
        console.log(`  Config: ${path}`);
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  const runtime = agent.command("runtime").description("Install and maintain the local agent runtime");

  runtime
    .command("install")
    .description("Download and verify the pinned cohub-locald runtime")
    .option("--version <version>", "Install a specific released runtime version")
    .option("--json", "Output as JSON")
    .action(async (opts: { version?: string; json?: boolean }) => {
      const progress = spinner();
      progress.start("Installing local agent runtime");
      try {
        const binary = await installLocaldBinary({ version: opts.version, onStatus: (message) => progress.update(message) });
        progress.stop("Local agent runtime installed");
        const result = { binary, version: opts.version?.trim() || process.env.COHUB_LOCALD_VERSION || "pinned" };
        if (jsonRequested(opts)) return outJson(result);
        console.log(`  Binary: ${binary}`);
      } catch (cause) {
        progress.stop("Local agent runtime installation failed");
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  runtime
    .command("update")
    .description("Re-download and verify the pinned cohub-locald runtime")
    .option("--version <version>", "Update to a specific released runtime version")
    .option("--json", "Output as JSON")
    .action(async (opts: { version?: string; json?: boolean }) => {
      const progress = spinner();
      progress.start("Updating local agent runtime");
      try {
        const binary = await updateLocaldBinary({ version: opts.version, onStatus: (message) => progress.update(message) });
        progress.stop("Local agent runtime updated");
        const result = { binary, version: opts.version?.trim() || process.env.COHUB_LOCALD_VERSION || "pinned" };
        if (jsonRequested(opts)) return outJson(result);
        console.log(`  Binary: ${binary}`);
      } catch (cause) {
        progress.stop("Local agent runtime update failed");
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  runtime
    .command("status")
    .description("Show the installed local agent runtime")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const configuredVersion = process.env.COHUB_LOCALD_VERSION?.trim() || "pinned";
      const cachedPath = (() => {
        try { return localdBinaryCachePath(process.env.COHUB_LOCALD_VERSION?.trim()); } catch { return null; }
      })();
      try {
        const binary = await resolveLocaldBinary({ download: false });
        const info = await stat(binary);
        const version = await commandVersion(binary);
        const result = { installed: true, binary, executable: info.isFile(), version: version ?? "unknown", cachedPath, configuredVersion };
        if (jsonRequested(opts)) return outJson(result);
        table([result], [
          { key: "binary", label: "Binary" },
          { key: "version", label: "Version" },
          { key: "configuredVersion", label: "Pinned" },
        ]);
      } catch (cause) {
        const result = { installed: false, binary: null, executable: false, version: null, cachedPath, configuredVersion };
        if (jsonRequested(opts)) return outJson(result);
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  runtime
    .command("register <spaceId> <replicaId> <provider>")
    .description("Register a local ACP runtime for an attached workspace")
    .option("--device-id <id>", "Use an enrolled device credential")
    .option("--name <name>", "Runtime display name")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, replicaId: string, providerInput: string, opts: { deviceId?: string; name?: string; json?: boolean }) => {
      const provider = parseProvider(providerInput);
      try {
        const client = createClient();
        const devices = (await client.localAgent.listDevices()).devices.filter((device) => device.status === "active");
        const deviceId = opts.deviceId?.trim() || devices[0]?.id;
        if (!deviceId) return error("Device unavailable", "Enroll a local device before registering a runtime.");
        const runtime = await client.localAgent.registerRuntime(spaceId, {
          deviceId,
          replicaId,
          provider,
          displayName: opts.name?.trim() || `${providerDisplayName(provider)} local runtime`,
          adapterVersion: "cohub-locald-acp-v1",
          capabilities: {
            sessionLoad: true,
            sessionResume: true,
            sessionCancel: true,
            permissionRequests: true,
            nativeTools: true,
          },
        });
        if (jsonRequested(opts)) return outJson(runtime);
        ok(`${providerDisplayName(provider)} ACP runtime registered`);
        console.log(`  Runtime: ${runtime.id}`);
        console.log(`  Replica: ${replicaId}`);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  runtime
    .command("list <spaceId>")
    .description("List registered local ACP runtimes")
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
    .command("start <spaceId> <replicaId> <provider>")
    .description("Start a local ACP runtime")
    .option("--runtime-id <id>", "Use an existing runtime registration")
    .option("--root <path>", "Attached workspace root")
    .option("--data-dir <path>", "locald state directory")
    .option("--relay <url>", "Gateway runtime relay URL")
    .option("--provider-command <command>", "ACP adapter command")
    .option("--foreground", "Keep the runtime attached to this terminal")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, replicaId: string, providerInput: string, opts: { runtimeId?: string; root?: string; dataDir?: string; relay?: string; providerCommand?: string; foreground?: boolean; json?: boolean }) => {
      const provider = parseProvider(providerInput);
      try {
        const binary = await resolveLocaldBinary();
        const dataDir = localdDataDir(opts.dataDir);
        const client = createClient();
        const runtimes = (await client.localAgent.listRuntimes(spaceId)).runtimes;
        let runtime = opts.runtimeId?.trim() ? runtimes.find((item) => item.id === opts.runtimeId?.trim()) : runtimes.find((item) => item.provider === provider && item.replicaId === replicaId);
        if (!runtime) {
          const devices = (await client.localAgent.listDevices()).devices.filter((device) => device.status === "active");
          const deviceId = devices[0]?.id;
          if (!deviceId) return error("Device unavailable", "Enroll a local device before starting a runtime.");
          runtime = await client.localAgent.registerRuntime(spaceId, {
            deviceId,
            replicaId,
            provider,
            displayName: `${providerDisplayName(provider)} local runtime`,
            adapterVersion: "cohub-locald-acp-v1",
            capabilities: { sessionLoad: true, sessionResume: true, sessionCancel: true, permissionRequests: true, nativeTools: true },
          });
        }
        if (runtime.status === "revoked") return error("Runtime revoked", "Register a new local ACP runtime before starting it.");
        if (runtime.provider !== provider || runtime.replicaId !== replicaId) {
          return error("Runtime binding mismatch", "The selected runtime is bound to a different provider or workspace replica.");
        }
        await ensureLocaldDaemon(binary, dataDir, runtime.deviceId);
        const statusOutput = await runLocaldCommand(binary, ["status", "--data-dir", dataDir, "--cwd", opts.root?.trim() || process.cwd()]);
        const status = JSON.parse(statusOutput) as { data?: { root?: string; replicaId?: string; spaceId?: string } };
        if (status.data?.spaceId && status.data.spaceId !== spaceId) return error("Workspace binding mismatch", "The selected local folder belongs to a different Space.");
        if (status.data?.replicaId && status.data.replicaId !== replicaId) return error("Workspace binding mismatch", "The selected local folder belongs to a different workspace replica.");
        const root = opts.root?.trim() || status.data?.root;
        if (!root) return error("Workspace root unavailable", "Pass --root or attach this folder with `cohub workspace attach` first.");
        if (status.data?.root && resolve(root) !== resolve(status.data.root)) return error("Workspace root mismatch", "The selected root does not match the attached local replica.");
        const started = startLocalAcpRuntime({ binary, dataDir, runtime, root, relay: opts.relay, providerCommand: opts.providerCommand, foreground: opts.foreground });
        const { wait, ...startedInfo } = started;
        const result = { ...startedInfo, runtimeId: runtime.id, spaceId, replicaId, provider, root };
        if (jsonRequested(opts)) outJson(result);
        else {
          ok(`${providerDisplayName(provider)} ACP runtime ${opts.foreground ? "running" : "started"}`);
          console.log(`  Runtime: ${runtime.id}`);
          console.log(`  Relay:   ${started.relay}`);
        }
        if (wait) {
          const code = await wait;
          if (code !== 0) return error("Local ACP runtime stopped", `Exit code: ${code ?? "unknown"}`);
        }
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });

  runtime
    .command("revoke <spaceId> <runtimeId>")
    .description("Revoke a local ACP runtime")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, runtimeId: string, opts: { json?: boolean }) => {
      try {
        const result = await createClient().localAgent.revokeRuntime(spaceId, runtimeId);
        if (jsonRequested(opts)) return outJson(result);
        ok("Local ACP runtime revoked");
      } catch (cause) {
        handleHttp(cause);
      }
    });

  agent
    .command("doctor")
    .description("Check locald, ACP adapters, and legacy provider hooks")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const binary = await resolveLocaldBinary();
        const binaryInfo = await stat(binary);
        await access(binary, constants.X_OK);
        const rows = await Promise.all(([
          ["pi", "pi"],
          ["claude_code", "claude"],
          ["codex", "codex"],
        ] as const).map(async ([provider, command]) => {
          const version = await commandVersion(command);
          const adapterCommand = providerAdapterCommand(provider);
          const adapterVersion = await commandVersion(adapterCommand);
          const installed = await hookInstalled(provider, binary);
          return {
            provider: providerDisplayName(provider),
            version: version ?? "not installed",
            adapter: adapterVersion ? `${adapterCommand} ${adapterVersion}` : `${adapterCommand} missing`,
            legacyHooks: installed ? "installed" : "missing",
            transcript: adapterVersion ? "ACP session/update" : "unavailable",
          };
        }));
        const result = { locald: { binary, executable: binaryInfo.isFile() }, providers: rows };
        if (jsonRequested(opts)) return outJson(result);
        table(rows, [
          { key: "provider", label: "Provider" },
          { key: "version", label: "Version" },
          { key: "adapter", label: "ACP adapter" },
          { key: "legacyHooks", label: "Legacy hooks" },
          { key: "transcript", label: "Mirror" },
        ]);
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });
}
