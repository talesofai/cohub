import type { SpaceHookEventEnvelope } from "@cohub/protocol";

export const SPACE_HOOK_FS_PATHS_LIMIT = 100;

export type SpaceHookContextInput = {
  event: SpaceHookEventEnvelope;
  hookPath: string;
  taskRunId: string;
  eventActorUserId?: string | null;
  executionUserId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function collectFsSummary(payload: Record<string, unknown>) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const paths: string[] = [];
  const kinds: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    if (typeof change.path === "string" && change.path.trim()) paths.push(normalizePath(change.path));
    if (typeof change.oldPath === "string" && change.oldPath.trim()) paths.push(normalizePath(change.oldPath));
    if (typeof change.kind === "string" && change.kind.trim()) kinds.push(change.kind.trim());
  }
  const uniquePaths = Array.from(new Set(paths));
  const uniqueKinds = Array.from(new Set(kinds));
  return {
    changeCount: uniquePaths.length,
    paths: uniquePaths.slice(0, SPACE_HOOK_FS_PATHS_LIMIT),
    kinds: uniqueKinds,
  };
}

function normalizeEnvValue(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

/** Always assign so run scripts under `set -u` can safely expand optional keys. */
function setEnv(env: Record<string, string>, key: string, value: string | null | undefined) {
  env[key] = normalizeEnvValue(value);
}

/**
 * Build the shared hook env for both run and prompt executions.
 * Optional COHUB_HOOK_* keys are always exported; absent values are "".
 * Prompt appendix still skips empty values for readability.
 */
export function buildSpaceHookEnv(input: SpaceHookContextInput): Record<string, string> {
  const { event, hookPath, taskRunId, eventActorUserId, executionUserId } = input;
  const turn = event.type === "session.turn.finalized" && isRecord(event.payload.turn)
    ? event.payload.turn
    : null;

  const env: Record<string, string> = {
    COHUB_HOOK_PATH: hookPath,
    COHUB_HOOK_TASK_RUN_ID: taskRunId,
    COHUB_HOOK_EVENT_ID: event.id,
    COHUB_HOOK_EVENT_TYPE: event.type,
    COHUB_HOOK_SPACE_ID: event.spaceId,
    COHUB_HOOK_OCCURRED_AT: new Date(event.timestamp).toISOString(),
    COHUB_HOOK_EXECUTION_USER_ID: executionUserId,
  };

  // Stable optional keys — always present for set -u safe shell scripts.
  setEnv(env, "COHUB_HOOK_ACTOR_USER_ID", eventActorUserId);
  setEnv(env, "COHUB_HOOK_SESSION_ID", event.sessionId);
  setEnv(env, "COHUB_HOOK_TURN_ID", turn ? asString(turn.id) : null);
  setEnv(
    env,
    "COHUB_HOOK_CHECKPOINT_ID",
    event.type === "checkpoint.created" ? asString(event.payload.checkpointId) : null,
  );
  const work = event.type === "work.version.published" && isRecord(event.payload.work)
    ? event.payload.work
    : null;
  const version = event.type === "work.version.published" && isRecord(event.payload.version)
    ? event.payload.version
    : null;
  setEnv(env, "COHUB_HOOK_WORK_ID", work ? asString(work.id) : null);
  setEnv(env, "COHUB_HOOK_WORK_VERSION_ID", version ? asString(version.id) : null);
  setEnv(
    env,
    "COHUB_HOOK_WORK_VERSION",
    typeof version?.version === "number" && Number.isFinite(version.version)
      ? String(version.version)
      : null,
  );

  if (event.type === "space.fs.changed") {
    const summary = collectFsSummary(event.payload);
    env.COHUB_HOOK_FS_CHANGE_COUNT = String(summary.changeCount);
    env.COHUB_HOOK_FS_PATHS = summary.paths.join("\n");
    env.COHUB_HOOK_FS_KINDS = summary.kinds.join(",");
  }

  if (event.type === "task.updated") {
    const task = isRecord(event.payload.task) ? event.payload.task : null;
    setEnv(env, "COHUB_HOOK_TASK_ID", task ? asString(task.id) : null);
    setEnv(env, "COHUB_HOOK_TASK_TYPE", task ? asString(task.type) : null);
    setEnv(env, "COHUB_HOOK_TASK_STATUS", task ? asString(task.status) : null);
    const changed = Array.isArray(event.payload.changed)
      ? event.payload.changed.filter((value): value is string => typeof value === "string")
      : [];
    setEnv(env, "COHUB_HOOK_TASK_CHANGED", changed.length > 0 ? changed.join(",") : null);
    setEnv(env, "COHUB_HOOK_TASK_ERROR", task ? asString(task.errorMessage) : null);
  }

  return env;
}

const PROMPT_CONTEXT_LABELS: Array<{ key: string; label: string }> = [
  { key: "COHUB_HOOK_EVENT_TYPE", label: "eventType" },
  { key: "COHUB_HOOK_EVENT_ID", label: "eventId" },
  { key: "COHUB_HOOK_TASK_RUN_ID", label: "taskRunId" },
  { key: "COHUB_HOOK_PATH", label: "hook" },
  { key: "COHUB_HOOK_SPACE_ID", label: "spaceId" },
  { key: "COHUB_HOOK_SESSION_ID", label: "sessionId" },
  { key: "COHUB_HOOK_TURN_ID", label: "turnId" },
  { key: "COHUB_HOOK_CHECKPOINT_ID", label: "checkpointId" },
  { key: "COHUB_HOOK_WORK_ID", label: "workId" },
  { key: "COHUB_HOOK_WORK_VERSION_ID", label: "workVersionId" },
  { key: "COHUB_HOOK_WORK_VERSION", label: "workVersion" },
  { key: "COHUB_HOOK_ACTOR_USER_ID", label: "actorUserId" },
  { key: "COHUB_HOOK_OCCURRED_AT", label: "occurredAt" },
  { key: "COHUB_HOOK_FS_CHANGE_COUNT", label: "changeCount" },
  { key: "COHUB_HOOK_FS_KINDS", label: "kinds" },
  { key: "COHUB_HOOK_TASK_ID", label: "taskId" },
  { key: "COHUB_HOOK_TASK_TYPE", label: "taskType" },
  { key: "COHUB_HOOK_TASK_STATUS", label: "taskStatus" },
  { key: "COHUB_HOOK_TASK_CHANGED", label: "taskChanged" },
  { key: "COHUB_HOOK_TASK_ERROR", label: "taskError" },
];

/** Compact prompt appendix mirrored from the shared hook env. */
export function buildSpaceHookPromptAppendix(env: Record<string, string>): string {
  const lines: string[] = ["---", "Hook context"];
  for (const { key, label } of PROMPT_CONTEXT_LABELS) {
    const value = env[key];
    if (value) lines.push(`- ${label}: ${value}`);
  }
  const paths = env.COHUB_HOOK_FS_PATHS;
  if (paths) {
    lines.push("- paths:");
    for (const path of paths.split("\n")) {
      if (path) lines.push(`  - ${path}`);
    }
  }
  return lines.join("\n");
}

export function buildSpaceHookPromptText(input: {
  promptText: string;
  env: Record<string, string>;
}): string {
  const base = input.promptText.trim();
  const appendix = buildSpaceHookPromptAppendix(input.env);
  return base ? `${base}\n\n${appendix}` : appendix;
}

/** Merge user hook env under system hook context. System keys always win. */
export function mergeSpaceHookExecutionEnv(input: {
  userEnv?: Record<string, string> | null;
  hookEnv: Record<string, string>;
}): Record<string, string> {
  return {
    ...(input.userEnv ?? {}),
    ...input.hookEnv,
  };
}
