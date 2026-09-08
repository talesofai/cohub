import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DetectedProvider = {
  provider: "codex" | "claude_code" | "pi";
  displayName: string;
};

export type ProviderDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  commandTimeoutMs?: number;
  /** Injected for tests; production probes use the user's PATH. */
  commandProbe?: (command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string }>;
};

const MAX_PROBE_OUTPUT_BYTES = 128 * 1024;

const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] as const;

const CLAUDE_DIRECT_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
] as const;

const CLAUDE_BEDROCK_ENV_KEYS = ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_WEB_IDENTITY_TOKEN_FILE"] as const;
const CLAUDE_VERTEX_ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS"] as const;

const PI_ENV_KEYS = [
  "AZURE_OPENAI_API_KEY",
  "ANT_LING_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "RADIUS_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
] as const;

const nonEmptyEnv = (env: NodeJS.ProcessEnv, names: readonly string[]) => names.some((name) => Boolean(env[name]?.trim()));

const truthyEnv = (env: NodeJS.ProcessEnv, names: readonly string[]) => names.some((name) => {
  const value = env[name]?.trim().toLowerCase();
  return value !== undefined && value.length > 0 && !["0", "false", "no", "off"].includes(value);
});

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasCodexCredential(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  const tokens = value.tokens;
  if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
    const record = tokens as Record<string, unknown>;
    if (typeof record.access_token === "string" && record.access_token.trim()) return true;
    if (typeof record.refresh_token === "string" && record.refresh_token.trim()) return true;
  }
  return ["OPENAI_API_KEY", "api_key", "access_token", "refresh_token"].some((key) => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0;
  });
}

function hasPiCredential(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  return Object.values(value).some((credential) => {
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) return false;
    const record = credential as Record<string, unknown>;
    if (record.type === "oauth" && ["access", "refresh"].some((key) => typeof record[key] === "string" && record[key].trim().length > 0)) return true;
    if (record.type === "api_key" && record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
      if (Object.values(record.env as Record<string, unknown>).some((item) => typeof item === "string" && item.trim().length > 0)) return true;
    }
    return Object.entries(record).some(([key, item]) =>
      (key.toLowerCase().includes("token") || key.toLowerCase().includes("key") || key.toLowerCase().includes("secret"))
      && typeof item === "string" && item.trim().length > 0,
    );
  });
}

function hasClaudeCredential(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  const oauth = value.claudeAiOauth;
  if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
    const record = oauth as Record<string, unknown>;
    if (["accessToken", "refreshToken", "token"].some((key) => typeof record[key] === "string" && String(record[key]).trim())) return true;
  }
  return ["accessToken", "access_token", "oauthToken", "apiKey", "token"].some((key) => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0;
  });
}

function defaultCommandProbe(command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const currentBytes = chunks.reduce((total, item) => total + item.byteLength, 0);
      const remaining = MAX_PROBE_OUTPUT_BYTES - currentBytes;
      if (remaining <= 0) {
        child.kill();
        finish(null);
        return;
      }
      chunks.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
      if (chunk.byteLength > remaining) {
        child.kill();
        finish(null);
      }
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function codexStatusHasCredentials(value: string): boolean {
  const normalized = value.toLowerCase();
  if (/not\s+logged\s+in|logged\s+out|no\s+api\s+key|unauthenticated/.test(normalized)) return false;
  return /logged\s+in|api\s+key|chatgpt/.test(normalized);
}

export async function detectLocalProviders(options: ProviderDetectionOptions = {}): Promise<DetectedProvider[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const timeoutMs = options.commandTimeoutMs ?? 2_000;
  const probe = options.commandProbe ?? ((command, args, timeout, probeEnv) => defaultCommandProbe(command, args, timeout, probeEnv ?? env));
  const detected: DetectedProvider[] = [];

  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const codexAuth = await readJson(join(codexHome, "auth.json"));
  const codexEnv = nonEmptyEnv(env, CODEX_ENV_KEYS);
  if (codexEnv || hasCodexCredential(codexAuth)) {
    detected.push({ provider: "codex", displayName: "Codex" });
  } else {
    const result = await probe("codex", ["login", "status"], timeoutMs, env);
    if (result.code === 0 && codexStatusHasCredentials(result.stdout)) {
      detected.push({ provider: "codex", displayName: "Codex" });
    }
  }

  const useBedrock = truthyEnv(env, ["CLAUDE_CODE_USE_BEDROCK"]);
  const useVertex = truthyEnv(env, ["CLAUDE_CODE_USE_VERTEX"]);
  const claudeEnv = nonEmptyEnv(env, CLAUDE_DIRECT_ENV_KEYS)
    || truthyEnv(env, ["CLAUDE_CODE_USE_FOUNDRY"])
    || (useBedrock && nonEmptyEnv(env, CLAUDE_BEDROCK_ENV_KEYS))
    || (useVertex && nonEmptyEnv(env, CLAUDE_VERTEX_ENV_KEYS));
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const claudeCredential = await readJson(join(claudeDir, ".credentials.json"));
  const claudeRootConfig = await readJson(join(home, ".claude.json"));
  if (claudeEnv || hasClaudeCredential(claudeCredential)) {
    detected.push({ provider: "claude_code", displayName: "Claude Code" });
  } else {
    const result = await probe("claude", ["auth", "status", "--json"], timeoutMs, env);
    const status = jsonObject(result.stdout);
    if (result.code === 0 && status?.loggedIn === true) {
      detected.push({ provider: "claude_code", displayName: "Claude Code" });
    } else if (await readableFile(join(home, ".claude.json")) && claudeRootConfig?.hasAvailableSubscription === true) {
      detected.push({ provider: "claude_code", displayName: "Claude Code" });
    }
  }

  const piDir = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  const piAuth = await readJson(join(piDir, "auth.json"));
  const piEnv = nonEmptyEnv(env, PI_ENV_KEYS);
  if (piEnv || hasPiCredential(piAuth)) {
    detected.push({ provider: "pi", displayName: "Pi" });
  }

  return detected;
}

export const providerDisplayName = (provider: DetectedProvider["provider"]): string =>
  provider === "claude_code" ? "Claude Code" : provider === "codex" ? "Codex" : "Pi";
