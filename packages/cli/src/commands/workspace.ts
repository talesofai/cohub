import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";

type WorkspaceOptions = { json?: boolean };


export function registerWorkspace(program: Command): void {
  const workspace = program.command("workspace").description("Manage a cloud Space workspace replica");

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
