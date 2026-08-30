import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { error, handleHttp, json as outJson, jsonRequested, ok, spinner, table } from "../output.js";
import {
  installLocaldBinary,
  LocaldUnavailableError,
  localdBinaryCachePath,
  resolveLocaldBinary,
  updateLocaldBinary,
} from "./locald-binary.js";

type Provider = "pi" | "claude_code" | "codex";

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

async function commandVersion(command: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => resolvePromise(null));
    child.once("close", (code) => resolvePromise(code === 0 ? Buffer.concat(output).toString("utf8").trim() || "unknown" : null));
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

  agent
    .command("doctor")
    .description("Check locald and provider hook capabilities")
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
          const installed = await hookInstalled(provider, binary);
          return {
            provider: providerDisplayName(provider),
            version: version ?? "not installed",
            hooks: installed ? "installed" : "missing",
            transcript: provider === "pi" && version ? "full (version fixture required)" : version ? "metadata_only" : "unavailable",
          };
        }));
        const result = { locald: { binary, executable: binaryInfo.isFile() }, providers: rows };
        if (jsonRequested(opts)) return outJson(result);
        table(rows, [
          { key: "provider", label: "Provider" },
          { key: "version", label: "Version" },
          { key: "hooks", label: "Hooks" },
          { key: "transcript", label: "Mirror" },
        ]);
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        handleHttp(cause);
      }
    });
}
