import { parseAgentPromptAccessMode, type AgentPromptAccessMode } from "@cohub/core/sessions";

export function resolvePromptAccessMode(ownerMeta: Record<string, unknown>): AgentPromptAccessMode {
  return parseAgentPromptAccessMode(ownerMeta.accessMode);
}

export function assertSandboxAccessMode(
  sandbox: { meta?: Record<string, unknown> | null } | null | undefined,
  accessMode: "read_only" | "full_access" | "isolated_worker",
) {
  const meta = sandbox?.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
  const isolated = Boolean(meta.isolatedWorker || meta.isolatedWorkerPolicy || meta.worker_identity);
  if (isolated && accessMode !== "isolated_worker") {
    throw new Error("generic Agent execution is forbidden in an isolated disposable Space");
  }
}
