import { AGENT_TURN_STEER_META_KEY } from "@cohub/core/sessions";

const normalizeRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export class CheckpointSteerCompletionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "session_mismatch" | "target_mismatch" | "invalid_state" | "racing_target",
  ) {
    super(message);
    this.name = "CheckpointSteerCompletionError";
  }
}

export const isCheckpointSteerConsumedForTarget = (input: {
  status: string;
  intent: string;
  meta: unknown;
  targetTurnId: string;
}) => {
  const delivery = normalizeRecord(normalizeRecord(input.meta)?.[AGENT_TURN_STEER_META_KEY]);
  return input.status === "merged"
    && input.intent === "steer"
    && delivery?.status === "consumed"
    && delivery?.mode === "checkpoint"
    && delivery.targetTurnId === input.targetTurnId;
};

export const isCheckpointSteerTargetStatusConsumable = (status: string) => [
  "running",
  "abort_requested",
  "completed",
  "interrupted",
  "aborted",
  "failed",
].includes(status);
