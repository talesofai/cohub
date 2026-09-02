import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@neta-art/cohub-cli";
export const SELF_UPDATE_WORKER_ENV = "COHUB_CLI_SELF_UPDATE_WORKER";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60 * 1000;

const STATE_PATH = join(homedir(), ".cache", "cohub-cli", "self-update.json");
const LOCK_PATH = join(homedir(), ".cache", "cohub-cli", "self-update.lock");
const PACKAGE_PATH = new URL("../package.json", import.meta.url);

export type CliSelfUpdateResult = "current" | "updated" | "updated-by-peer";

type UpdateState = {
  lastUpdatedAt?: string;
};

const parsePositiveIntEnv = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getIntervalMs = () => {
  const explicitMs = process.env.COHUB_CLI_UPDATE_INTERVAL_MS;
  if (explicitMs?.trim()) return parsePositiveIntEnv("COHUB_CLI_UPDATE_INTERVAL_MS", DEFAULT_INTERVAL_MS);

  const hours = process.env.COHUB_CLI_UPDATE_INTERVAL_HOURS;
  if (hours?.trim()) {
    const value = Number.parseFloat(hours);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 60 * 60 * 1000);
  }

  return DEFAULT_INTERVAL_MS;
};

const getTimeoutMs = () => parsePositiveIntEnv("COHUB_CLI_UPDATE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

const readState = (): UpdateState => {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as UpdateState;
  } catch {
    return {};
  }
};

const writeState = () => {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ lastUpdatedAt: new Date().toISOString() }, null, 2)}\n`);
};

const readInstalledVersion = (): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
};

export function resolveSelfUpdateResult(beforeVersion: string | undefined, afterVersion: string | undefined, updatedByPeer: boolean): CliSelfUpdateResult {
  if (beforeVersion !== undefined && beforeVersion === afterVersion) return "current";
  return updatedByPeer ? "updated-by-peer" : "updated";
}

export const isCliSelfUpdateDue = (): boolean => {
  const state = readState();
  if (!state.lastUpdatedAt) return true;
  const lastUpdatedAt = Date.parse(state.lastUpdatedAt);
  if (!Number.isFinite(lastUpdatedAt)) return true;
  return Date.now() - lastUpdatedAt >= getIntervalMs();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const acquireLock = async (timeoutMs: number) => {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      mkdirSync(LOCK_PATH);
      writeFileSync(join(LOCK_PATH, "pid"), `${process.pid}\n${Date.now()}\n`);
      return true;
    } catch {
      try {
        const raw = readFileSync(join(LOCK_PATH, "pid"), "utf-8");
        const timestamp = Number.parseInt(raw.trim().split(/\s+/).at(-1) ?? "0", 10);
        if (!Number.isFinite(timestamp) || Date.now() - timestamp > LOCK_STALE_MS) {
          rmSync(LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(LOCK_PATH, { recursive: true, force: true });
        continue;
      }

      await sleep(250);
    }
  }

  return false;
};

const releaseLock = () => {
  rmSync(LOCK_PATH, { recursive: true, force: true });
};

const runNpmUpdate = (timeoutMs: number) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@latest`, "--silent"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      const detail = [stderr, stdout].filter(Boolean).join("\n");
      reject(new Error(`npm install -g ${PACKAGE_NAME}@latest failed${signal ? ` (${signal})` : code !== null ? ` (exit ${code})` : ""}${detail ? `:\n${detail}` : ""}`));
    });
  });
};

export function startCliSelfUpdate(entrypoint: string): void {
  if (process.env.COHUB_CLI_AUTO_UPDATE === "0" || !isCliSelfUpdateDue()) return;

  const worker = spawn(process.execPath, [entrypoint], {
    detached: true,
    env: { ...process.env, [SELF_UPDATE_WORKER_ENV]: "1" },
    stdio: "ignore",
  });
  worker.on("error", () => undefined);
  worker.unref();
}

export async function ensureCliSelfUpdated(): Promise<CliSelfUpdateResult> {
  if (process.env.COHUB_CLI_AUTO_UPDATE === "0") return "current";
  if (!isCliSelfUpdateDue()) return "current";

  const beforeVersion = readInstalledVersion();
  const timeoutMs = getTimeoutMs();
  const locked = await acquireLock(timeoutMs);
  if (!locked) {
    throw new Error(`Timed out waiting for ${PACKAGE_NAME} self-update lock after ${timeoutMs}ms`);
  }

  try {
    // Another process may have completed the update while this process was
    // waiting for the lock.
    if (!isCliSelfUpdateDue()) {
      return resolveSelfUpdateResult(beforeVersion, readInstalledVersion(), true);
    }

    await runNpmUpdate(timeoutMs);
    writeState();
    return resolveSelfUpdateResult(beforeVersion, readInstalledVersion(), false);
  } finally {
    releaseLock();
  }
}
