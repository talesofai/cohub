import type { ContentBlock } from "@cohub/protocol/core";

export const RUN_COMMAND_TASK_TYPE = "run_command" as const;
export const RUN_COMMAND_TOOL_NAME = "bash" as const;
export const RUN_COMMAND_TIMEOUT_SECONDS = 6 * 60 * 60;
export const MAX_RUN_COMMAND_TIMEOUT_SECONDS = RUN_COMMAND_TIMEOUT_SECONDS;

export type RunCommandTaskType = typeof RUN_COMMAND_TASK_TYPE;

export type RunCommandTaskData = {
  command: string;
  cwd: string;
  source?: string | null;
};

export type RunCommandTaskProgress = {
  kind: RunCommandTaskType;
  phase: "queued" | "running";
  content: ContentBlock[];
};

export type RunCommandTermination = {
  reason: "exited" | "timed_out" | "aborted";
  exitCode: number | null;
  timeoutSecs?: number;
  message?: string;
  outputTruncated?: boolean;
};

export type RunCommandTaskResult = {
  kind: RunCommandTaskType;
  exitCode: number | null;
  termination?: RunCommandTermination;
  durationMs: number;
  command: string;
  cwd: string;
  content: ContentBlock[];
};

export type RunCommandToolCallState = {
  toolCallId: string;
  command: string;
  cwd: string;
  output?: string | null;
  status?: "running" | "done";
  exitCode?: number | null;
  termination?: RunCommandTermination | null;
  durationMs?: number | null;
};

function clampOutput(value: string, limit = 128 * 1024) {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n… output truncated …`, truncated: true };
}

export function buildRunCommandToolContent(state: RunCommandToolCallState): ContentBlock[] {
  const terminationNote = state.termination?.message && state.termination.reason !== "exited" ? `[${state.termination.message}]` : "";
  const output = terminationNote ? `${state.output ?? ""}${state.output ? "\n\n" : ""}${terminationNote}` : state.output ?? "";
  const { text, truncated } = clampOutput(output);
  const toolUse: ContentBlock = {
    type: "tool_use",
    id: state.toolCallId,
    name: RUN_COMMAND_TOOL_NAME,
    input: {
      command: state.command,
      cwd: state.cwd,
    },
    _meta: {
      toolStatus: state.status ?? "running",
      partialResult: state.status === "running" && text ? text : undefined,
      command: state.command,
      cwd: state.cwd,
      truncated,
    },
  };

  if (state.status !== "done") return [toolUse];

  const toolResult: ContentBlock = {
    type: "tool_result",
    tool_use_id: state.toolCallId,
    content: text,
    is_error: false,
    _meta: {
      exitCode: state.exitCode ?? null,
      termination: state.termination ?? undefined,
      durationMs: state.durationMs ?? null,
      truncated,
    },
  };

  return [toolUse, toolResult];
}

export function buildRunCommandQueuedProgress(state: RunCommandToolCallState): RunCommandTaskProgress {
  return {
    kind: RUN_COMMAND_TASK_TYPE,
    phase: "queued",
    content: buildRunCommandToolContent({ ...state, status: "running", output: state.output ?? "" }),
  };
}

export function buildRunCommandRunningProgress(state: RunCommandToolCallState): RunCommandTaskProgress {
  return {
    kind: RUN_COMMAND_TASK_TYPE,
    phase: "running",
    content: buildRunCommandToolContent({ ...state, status: "running" }),
  };
}

export function buildRunCommandResult(state: RunCommandToolCallState): RunCommandTaskResult {
  return {
    kind: RUN_COMMAND_TASK_TYPE,
    exitCode: state.exitCode ?? null,
    termination: state.termination ?? undefined,
    durationMs: state.durationMs ?? 0,
    command: state.command,
    cwd: state.cwd,
    content: buildRunCommandToolContent({ ...state, status: "done" }),
  };
}
