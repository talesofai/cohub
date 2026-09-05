import { spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { platform, homedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { LocalAgentDevice } from "@neta-art/cohub";
import { resolveApiBaseUrl } from "@neta-art/cohub";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveLocaldBinary, LocaldUnavailableError } from "./locald-binary.js";

const WORKSPACE_MODES = ["two_way_safe", "one_way_to_cloud", "one_way_to_local", "handoff"] as const;
type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

type WorkspaceOptions = {
  json?: boolean;
  deviceId?: string;
  dataDir?: string;
  name?: string;
  mode?: string;
  yes?: boolean;
  useCloud?: boolean;
  useLocal?: boolean;
  merge?: boolean;
};

function choose<T extends readonly string[]>(value: string | undefined, values: T, name: string): T[number] {
  if (!value || values.includes(value as T[number])) return (value ?? values[0]) as T[number];
  return error(`Invalid ${name}`, `Use one of: ${values.join(", ")}`);
}

function localdDataDir(value?: string) {
  return value?.trim() || process.env.COHUB_LOCALD_DATA_DIR?.trim() || resolve(homedir(), ".local", "share", "cohub", "locald");
}

async function workspaceRootHasContent(root: string) {
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

export function resolveInitialChoice(opts: Pick<WorkspaceOptions, "useCloud" | "useLocal" | "merge">, hasContent: boolean): "use-cloud" | "use-local" | "merge" {
  const choices = [
    opts.useCloud ? "use-cloud" as const : null,
    opts.useLocal ? "use-local" as const : null,
    opts.merge ? "merge" as const : null,
  ].filter((choice): choice is "use-cloud" | "use-local" | "merge" => choice !== null);
  if (choices.length > 1) throw new Error("Choose one initial strategy: use only one of --merge, --use-cloud, or --use-local.");
  if (choices[0]) return choices[0];
  if (!hasContent) return "use-cloud";
  throw new Error("Initial strategy required: this folder is not empty. Use --merge, --use-cloud, or --use-local.");
}

async function runLocald(binary: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise(Buffer.concat(stdout).toString("utf8"));
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `cohub-locald exited with code ${code ?? "unknown"}`));
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

function startLocald(binary: string, dataDir: string, apiBaseUrl: string, deviceId: string): ChildProcess {
  const child = spawn(binary, ["daemon", "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COHUB_API_URL: apiBaseUrl,
      COHUB_LOCAL_AGENT_DEVICE_ID: deviceId,
      COHUB_LOCALD_DATA_DIR: dataDir,
    },
  });
  child.unref();
  return child;
}

async function ensureLocald(binary: string, dataDir: string, deviceId: string) {
  const apiBaseUrl = resolveApiBaseUrl({});
  try {
    const result = JSON.parse(await runLocald(binary, ["status", "--data-dir", dataDir])) as { ok?: boolean };
    if (result.ok) return;
  } catch {
    // Start below and wait for the socket to become ready.
  }
  startLocald(binary, dataDir, apiBaseUrl, deviceId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
    try {
      const result = JSON.parse(await runLocald(binary, ["status", "--data-dir", dataDir])) as { ok?: boolean };
      if (result.ok) return;
    } catch {
      // Keep polling within the bounded startup window.
    }
  }
  throw new Error("cohub-locald did not become ready");
}

async function resolveDevice(client: ReturnType<typeof createClient>, opts: WorkspaceOptions, binary: string, dataDir: string): Promise<{ device: LocalAgentDevice; newlyEnrolled: boolean }> {
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
      return error("Device credential unavailable", "This machine does not hold that device's refresh credential. Attach without --device-id to enroll this machine.");
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

export function registerWorkspace(program: Command): void {
  const workspace = program.command("workspace").description("Manage a cloud Space workspace replica");

  workspace
    .command("attach <spaceId> [root]")
    .description("Attach a local folder to a cloud Space workspace")
    .option("--device-id <id>", "Use an existing enrolled device")
    .option("--name <name>", "Device or replica display name")
    .option("--mode <mode>", "Workspace mode: two_way_safe, one_way_to_cloud, one_way_to_local, handoff", "two_way_safe")
    .option("--data-dir <path>", "locald state directory")
    .option("--merge", "Merge local and cloud trees, stopping on overlapping changes")
    .option("--use-cloud", "Replace managed local content after creating a local recovery backup")
    .option("--use-local", "Make the local tree authoritative for initial reconciliation")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string, rootArg: string | undefined, opts: WorkspaceOptions) => {
      const root = resolve(rootArg ?? process.cwd());
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) return error("Invalid workspace root", `${root} is not a directory`);
      const mode = choose(opts.mode, WORKSPACE_MODES, "workspace mode") as WorkspaceMode;
      let initialChoice: "use-cloud" | "use-local" | "merge";
      try {
        initialChoice = resolveInitialChoice(opts, await workspaceRootHasContent(root));
      } catch (cause) {
        return handleHttp(cause);
      }
      let binary: string;
      try {
        binary = await resolveLocaldBinary();
      } catch (cause) {
        if (cause instanceof LocaldUnavailableError) return error("Local agent runtime unavailable", cause.message);
        throw cause;
      }
      const dataDir = localdDataDir(opts.dataDir);
      const client = createClient();
      try {
        const { device, newlyEnrolled } = await resolveDevice(client, opts, binary, dataDir);
        const fingerprintOutput = await runLocald(binary, ["fingerprint", "--space-id", spaceId, "--root", root]);
        const parsedFingerprint = JSON.parse(fingerprintOutput) as { rootFingerprint?: unknown };
        const rootFingerprint = typeof parsedFingerprint.rootFingerprint === "string" ? parsedFingerprint.rootFingerprint.trim() : "";
        if (!/^[a-f0-9]{64}$/.test(rootFingerprint)) {
          throw new Error("cohub-locald returned an invalid device-scoped root fingerprint");
        }
        const attached = await client.localAgent.attach(spaceId, {
          deviceId: device.id,
          rootFingerprint,
          displayName: opts.name?.trim() || root.split(/[\\/]/).pop() || "workspace",
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
          : (await client.localAgent.updatePolicy(spaceId, device.id, { workspaceMode: mode })).policy as { integrationPolicyVersion?: number };
        const integrationPolicyVersion = policy.integrationPolicyVersion;
        if (!Number.isSafeInteger(integrationPolicyVersion) || Number(integrationPolicyVersion) < 1) {
          throw new Error("Local agent policy response has no valid integrationPolicyVersion");
        }
        await ensureLocald(binary, dataDir, device.id);
        await runLocald(binary, ["configure", "--data-dir", dataDir, "--space-id", spaceId, "--replica-id", String(attached.replica.id), "--device-id", device.id, "--root", root, "--root-fingerprint", rootFingerprint, "--policy-version", String((attached.workspacePolicy as { policyVersion?: number }).policyVersion ?? 1), "--integration-policy-version", String(integrationPolicyVersion), "--initial-choice", initialChoice]);
        if (jsonRequested(opts)) return outJson({ spaceId, root, device, replica: attached.replica, cloudReplica: attached.cloudReplica, workspace: attached.workspace, newlyEnrolled });
        ok(`Workspace attached to ${spaceId}`);
        console.log(`  Root:    ${root}`);
        console.log(`  Replica: ${String(attached.replica.id)}`);
        console.log(`  Mode:    ${mode}`);
        console.log(`  Initial: ${initialChoice}`);
        console.log("  locald is running and will synchronize in the background.");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  workspace
    .command("status")
    .description("Show local and cloud workspace replica state")
    .option("-s, --space <id>", "Target Space ID")
    .option("--replica-id <id>", "Replica ID")
    .option("--data-dir <path>", "locald state directory")
    .option("--json", "Output as JSON")
    .action(async (opts: WorkspaceOptions & { space?: string; replicaId?: string }) => {
      const spaceId = opts.space?.trim() || (program.opts() as { space?: string }).space;
      if (!spaceId || !opts.replicaId) return error("Space and replica are required", "Use --space <id> --replica-id <id>.");
      try {
        const result = await createClient().localAgent.state(spaceId, opts.replicaId);
        if (jsonRequested(opts)) return outJson(result);
        table([{
          spaceId,
          replicaId: opts.replicaId,
          workspaceStatus: (result.workspace as { status?: string } | null)?.status ?? "unknown",
          canonicalSnapshot: (result.workspace as { canonicalSnapshotId?: string } | null)?.canonicalSnapshotId ?? "",
          appliedSnapshot: (result.replica as { appliedSnapshotId?: string } | null)?.appliedSnapshotId ?? "",
          conflicts: result.openConflictCount,
        }], [
          { key: "spaceId", label: "Space" },
          { key: "replicaId", label: "Replica" },
          { key: "workspaceStatus", label: "Status" },
          { key: "canonicalSnapshot", label: "Canonical" },
          { key: "appliedSnapshot", label: "Applied" },
          { key: "conflicts", label: "Conflicts" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  workspace
    .command("conflicts")
    .description("List unresolved workspace conflicts")
    .option("-s, --space <id>", "Target Space ID")
    .option("--replica-id <id>", "Filter by replica")
    .option("--json", "Output as JSON")
    .action(async (opts: { space?: string; replicaId?: string; json?: boolean }) => {
      const spaceId = opts.space?.trim() || (program.opts() as { space?: string }).space;
      if (!spaceId) return error("Space is required", "Use --space <id>.");
      try {
        const result = await createClient().localAgent.conflicts(spaceId, opts.replicaId);
        if (jsonRequested(opts)) return outJson(result);
        table(result.conflicts, [
          { key: "id", label: "ID" },
          { key: "path", label: "Path" },
          { key: "kind", label: "Kind" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  workspace
    .command("resolve <conflictId>")
    .description("Resolve one workspace conflict using a retained side")
    .requiredOption("-s, --space <id>", "Target Space ID")
    .option("--use-local", "Keep the local candidate value")
    .option("--use-cloud", "Keep the cloud value")
    .option("--delete", "Delete the path from the canonical result")
    .option("--keep-managed", "Keep the managed local candidate value")
    .option("--json", "Output as JSON")
    .action(async (conflictId: string, opts: { space: string; useLocal?: boolean; useCloud?: boolean; delete?: boolean; keepManaged?: boolean; json?: boolean }) => {
      const resolutions = [
        opts.useLocal ? "local" as const : null,
        opts.useCloud ? "cloud" as const : null,
        opts.delete ? "deleted" as const : null,
        opts.keepManaged ? "keep_managed" as const : null,
      ].filter((value): value is "local" | "cloud" | "deleted" | "keep_managed" => value !== null);
      if (resolutions.length !== 1) return error("Resolution required", "Use exactly one of --use-local, --use-cloud, --delete, or --keep-managed.");
      try {
        const result = await createClient().localAgent.resolveConflict(opts.space, conflictId, resolutions[0] as "local" | "cloud" | "deleted" | "keep_managed");
        if (jsonRequested(opts)) return outJson(result);
        ok(result.queued ? "Conflict resolved; workspace reconciliation queued" : "Conflict resolution recorded");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
