import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import {
  ensureWorkspaceReplica,
  resolveInitialChoice,
  WORKSPACE_MODES,
  type WorkspaceMode,
} from "./local-workspace.js";

export { resolveInitialChoice } from "./local-workspace.js";

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
        initialChoice = resolveInitialChoice(opts, await (async () => {
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
        })());
      } catch (cause) {
        return handleHttp(cause);
      }
      try {
        const prepared = await ensureWorkspaceReplica({
          client: createClient(),
          spaceId,
          root,
          options: {
            dataDir: opts.dataDir,
            deviceId: opts.deviceId,
            name: opts.name,
            mode,
            initialChoice,
          },
        });
        if (jsonRequested(opts)) return outJson({ spaceId, root: prepared.root, device: prepared.device, replica: prepared.attached.replica, cloudReplica: prepared.attached.cloudReplica, workspace: prepared.attached.workspace, newlyEnrolled: prepared.newlyEnrolled });
        ok(`Workspace attached to ${spaceId}`);
        console.log(`  Root:    ${root}`);
        console.log(`  Replica: ${String(prepared.attached.replica.id)}`);
        console.log(`  Mode:    ${mode}`);
        console.log(`  Initial: ${prepared.initialChoice}`);
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
