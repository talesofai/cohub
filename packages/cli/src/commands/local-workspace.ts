import { spawn, type ChildProcess } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalAgentDevice } from "@neta-art/cohub";
import { resolveApiBaseUrl } from "@neta-art/cohub";
import { createClient } from "../client.js";
import { error } from "../output.js";
import { LocaldUnavailableError, resolveLocaldBinary } from "./locald-binary.js";

export const WORKSPACE_MODES = ["two_way_safe", "one_way_to_cloud", "one_way_to_local", "handoff"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];
export type InitialChoice = "use-cloud" | "use-local" | "merge";

export type LocalWorkspaceOptions = {
  dataDir?: string;
  deviceId?: string;
  name?: string;
  mode?: string;
  initialChoice?: InitialChoice;
  /** Select a safe initial strategy when the caller does not expose strategy flags. */
  automatic?: boolean;
};

export type WorkspaceAttachment = {
  binary: string;
  dataDir: string;
  root: string;
  device: LocalAgentDevice;
  attached: {
    replica: Record<string, unknown>;
    cloudReplica: Record<string, unknown>;
    workspace: Record<string, unknown>;
    workspacePolicy: Record<string, unknown>;
    integrationPolicy: Record<string, unknown>;
    bootstrapCycleId: string | null;
  };
  initialChoice: InitialChoice;
  integrationPolicyVersion: number;
  newlyEnrolled: boolean;
};

export function localdDataDir(value?: string): string {
  return value?.trim() || process.env.COHUB_LOCALD_DATA_DIR?.trim() || resolve(homedir(), ".local", "share", "cohub", "locald");
}

export async function workspaceRootHasContent(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    if (entry.name === ".cohub" && entry.isDirectory()) {
      const cohubEntries = await readdir(resolve(root, ".cohub"), { withFileTypes: true }).catch(() => []);
      if (cohubEntries.every((item) => item.name === "system")) continue;
    }
    return true;
  }
  return false;
}

function rootsOverlap(left: string, right: string): boolean {
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  if (leftPath === rightPath) return true;
  const leftToRight = relative(leftPath, rightPath);
  const rightToLeft = relative(rightPath, leftPath);
  const inside = (value: string) => value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return inside(leftToRight) || inside(rightToLeft);
}

export function resolveInitialChoice(
  opts: Pick<LocalWorkspaceOptions, "initialChoice"> & { useCloud?: boolean; useLocal?: boolean; merge?: boolean },
  hasContent: boolean,
  automatic = false,
): InitialChoice {
  const choices = [
    opts.useCloud ? "use-cloud" as const : null,
    opts.useLocal ? "use-local" as const : null,
    opts.merge ? "merge" as const : null,
    opts.initialChoice ?? null,
  ].filter((choice): choice is InitialChoice => choice !== null);
  if (choices.length > 1) throw new Error("Choose one initial strategy: use only one of --merge, --use-cloud, or --use-local.");
  if (choices[0]) return choices[0];
  if (!hasContent) return "use-cloud";
  if (automatic) return "merge";
  throw new Error("Initial strategy required: this folder is not empty. Use --merge, --use-cloud, or --use-local.");
}

export async function runLocald(binary: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `cohub-locald exited with code ${code ?? "unknown"}`));
    });
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

export function startLocald(binary: string, dataDir: string, deviceId: string): ChildProcess {
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
  child.once("error", () => undefined);
  child.unref();
  return child;
}

export async function ensureLocald(binary: string, dataDir: string, deviceId: string): Promise<void> {
  const check = async (): Promise<boolean> => {
    const result = JSON.parse(await runLocald(binary, ["status", "--data-dir", dataDir])) as {
      ok?: boolean;
      data?: { deviceId?: unknown } | null;
    };
    if (!result.ok) return false;
    const runningDeviceId = typeof result.data?.deviceId === "string" ? result.data.deviceId.trim() : "";
    if (!runningDeviceId || runningDeviceId !== deviceId) {
      throw new Error("cohub-locald is serving a different or unknown device; stop the existing daemon and retry");
    }
    return true;
  };
  try {
    if (await check()) return;
  } catch (error) {
    // A daemon that is already serving another device must not be reused.
    // Preserve that explicit error instead of hiding it behind a startup retry.
    if (error instanceof Error && /different or unknown device/u.test(error.message)) throw error;
  }
  startLocald(binary, dataDir, deviceId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
    try {
      if (await check()) return;
    } catch (error) {
      if (error instanceof Error && /different or unknown device/u.test(error.message)) throw error;
      // Keep polling within the bounded startup window.
    }
  }
  throw new Error("cohub-locald did not become ready");
}

async function resolveDevice(
  client: ReturnType<typeof createClient>,
  opts: LocalWorkspaceOptions,
  binary: string,
  dataDir: string,
): Promise<{ device: LocalAgentDevice; newlyEnrolled: boolean }> {
  const devices = (await client.localAgent.listDevices()).devices.filter((device) => device.status === "active");
  const credentialOutput = await runLocald(binary, ["credentials-status", "--data-dir", dataDir]).catch(() => "");
  let credentialDeviceId: string | null = null;
  try {
    const parsed = JSON.parse(credentialOutput) as { deviceId?: unknown };
    credentialDeviceId = typeof parsed.deviceId === "string" && parsed.deviceId.trim() ? parsed.deviceId.trim() : null;
  } catch {
    credentialDeviceId = null;
  }
  if (opts.deviceId) {
    const device = devices.find((item) => item.id === opts.deviceId);
    if (!device) return error("Device not found", `No active local agent device ${opts.deviceId} belongs to this account.`);
    if (credentialDeviceId !== device.id) {
      return error("Device credential unavailable", "This machine does not hold that device's refresh credential.");
    }
    return { device, newlyEnrolled: false };
  }
  const existing = credentialDeviceId ? devices.find((device) => device.id === credentialDeviceId) : undefined;
  if (existing) return { device: existing, newlyEnrolled: false };
  const enrolled = await client.localAgent.enroll({
    displayName: opts.name?.trim() || `${platform()} local workspace`,
    platform: `${platform()}-${process.arch}`,
    daemonVersion: process.env.COHUB_LOCALD_VERSION ?? "dev",
  });
  await runLocald(binary, ["credentials", "--data-dir", dataDir], `${JSON.stringify({
    deviceId: enrolled.device.id,
    accessToken: enrolled.accessToken,
    refreshToken: enrolled.refreshToken,
    apiBaseUrl: resolveApiBaseUrl({}),
  })}\n`);
  return { device: enrolled.device, newlyEnrolled: true };
}

const storedInitialChoice = (replica: Record<string, unknown> | undefined): InitialChoice | undefined => {
  const capabilities = replica?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const value = (capabilities as Record<string, unknown>).initialChoice;
  return value === "use-cloud" || value === "use-local" || value === "merge" ? value : undefined;
};

export async function ensureWorkspaceReplica(input: {
  client?: ReturnType<typeof createClient>;
  spaceId: string;
  root: string;
  options?: LocalWorkspaceOptions;
  binary?: string;
}): Promise<WorkspaceAttachment> {
  const requestedRoot = resolve(input.root);
  const info = await stat(requestedRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Invalid workspace root: ${requestedRoot} is not a directory`);
  const root = await realpath(requestedRoot).catch(() => requestedRoot);
  const options = input.options ?? {};
  const mode = options.mode?.trim() || "two_way_safe";
  if (!WORKSPACE_MODES.includes(mode as WorkspaceMode)) throw new Error(`Invalid workspace mode: ${mode}`);
  const binary = input.binary ?? await resolveLocaldBinary();
  const dataDir = localdDataDir(options.dataDir);
  const client = input.client ?? createClient();
  const { device, newlyEnrolled } = await resolveDevice(client, options, binary, dataDir);
  await ensureLocald(binary, dataDir, device.id);
  const daemonStatusOutput = await runLocald(binary, ["status", "--data-dir", dataDir]).catch(() => "");
  try {
    const parsed = JSON.parse(daemonStatusOutput) as { data?: { replicas?: unknown } };
    const replicas = Array.isArray(parsed.data?.replicas) ? parsed.data.replicas : [];
    for (const value of replicas) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const replica = value as { root?: unknown; spaceId?: unknown };
      if (typeof replica.root !== "string" || !replica.root.trim()) continue;
      const existingRoot = resolve(replica.root);
      if (!rootsOverlap(root, existingRoot)) continue;
      if (existingRoot !== root || replica.spaceId !== input.spaceId) {
        throw new Error("The selected local folder overlaps an attached workspace root; detach the overlapping replica first.");
      }
    }
  } catch (error) {
    if (error instanceof Error && /overlaps an attached workspace root/u.test(error.message)) throw error;
  }
  const localStatusOutput = await runLocald(binary, ["status", "--data-dir", dataDir, "--cwd", root]).catch(() => "");
  let localStatus: { spaceId?: string; replicaId?: string; root?: string; initialChoice?: string } | undefined;
  try {
    const parsed = JSON.parse(localStatusOutput) as { data?: Record<string, unknown> };
    if (parsed.data && typeof parsed.data === "object") {
      localStatus = {
        spaceId: typeof parsed.data.spaceId === "string" ? parsed.data.spaceId : undefined,
        replicaId: typeof parsed.data.replicaId === "string" ? parsed.data.replicaId : undefined,
        root: typeof parsed.data.root === "string" ? parsed.data.root : undefined,
        initialChoice: typeof parsed.data.initialChoice === "string" ? parsed.data.initialChoice : undefined,
      };
    }
  } catch {
    localStatus = undefined;
  }
  if (localStatus?.spaceId && localStatus.spaceId !== input.spaceId) {
    throw new Error("The selected local folder is already attached to a different Space.");
  }
  if (localStatus?.root && resolve(localStatus.root) !== root) {
    throw new Error("The selected local folder does not match its attached workspace root.");
  }
  const fingerprintOutput = await runLocald(binary, ["fingerprint", "--space-id", input.spaceId, "--root", root]);
  const parsedFingerprint = JSON.parse(fingerprintOutput) as { rootFingerprint?: unknown };
  const rootFingerprint = typeof parsedFingerprint.rootFingerprint === "string" ? parsedFingerprint.rootFingerprint.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(rootFingerprint)) throw new Error("cohub-locald returned an invalid device-scoped root fingerprint");

  let existingReplica: Record<string, unknown> | undefined;
  try {
    const overview = await client.localAgent.listReplicas(input.spaceId);
    existingReplica = overview.replicas.find((replica) =>
      replica.kind === "local" && replica.deviceId === device.id && replica.rootFingerprint === rootFingerprint,
    );
  } catch {
    // Attach remains the source of truth when the overview endpoint is unavailable.
  }
  const initialChoice = (localStatus?.initialChoice === "use-cloud" || localStatus?.initialChoice === "use-local" || localStatus?.initialChoice === "merge"
    ? localStatus.initialChoice
    : undefined)
    ?? storedInitialChoice(existingReplica)
    ?? resolveInitialChoice({ initialChoice: options.initialChoice }, await workspaceRootHasContent(root), options.automatic === true);
  const attached = await client.localAgent.attach(input.spaceId, {
    deviceId: device.id,
    rootFingerprint,
    displayName: options.name?.trim() || root.split(/[\\/]/).pop() || "workspace",
    capabilities: {
      platform: process.platform,
      architecture: process.arch,
      caseSensitive: process.platform !== "win32" && process.platform !== "darwin",
      symlinkSupport: true,
      initialChoice,
    },
    protocolVersion: 1,
  });
  const currentPolicy = attached.integrationPolicy as { workspaceMode?: string; integrationPolicyVersion?: number };
  const policy = currentPolicy.workspaceMode === mode
    ? currentPolicy
    : (await client.localAgent.updatePolicy(input.spaceId, device.id, { workspaceMode: mode as WorkspaceMode })).policy as { integrationPolicyVersion?: number };
  const integrationPolicyVersion = policy.integrationPolicyVersion;
  if (!Number.isSafeInteger(integrationPolicyVersion) || Number(integrationPolicyVersion) < 1) throw new Error("Local agent policy response has no valid integrationPolicyVersion");
  const validIntegrationPolicyVersion = Number(integrationPolicyVersion);
  const effectiveInitialChoice = storedInitialChoice(attached.replica) ?? initialChoice;
  await runLocald(binary, [
    "configure", "--data-dir", dataDir, "--space-id", input.spaceId,
    "--replica-id", String(attached.replica.id), "--device-id", device.id,
    "--root", root, "--root-fingerprint", rootFingerprint,
    "--policy-version", String((attached.workspacePolicy as { policyVersion?: number }).policyVersion ?? 1),
    "--integration-policy-version", String(validIntegrationPolicyVersion),
    "--initial-choice", effectiveInitialChoice,
  ]);
  return {
    binary,
    dataDir,
    root,
    device,
    attached,
    initialChoice: effectiveInitialChoice,
    integrationPolicyVersion: validIntegrationPolicyVersion,
    newlyEnrolled,
  };
}

export { LocaldUnavailableError };
