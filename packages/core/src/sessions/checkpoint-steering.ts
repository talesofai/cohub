export const AGENT_TURN_STEER_CHANNEL = "pubsub:agent:turn_steer";
export const AGENT_TURN_STEER_TTL_SECONDS = 60 * 60;
export const AGENT_TURN_STEER_META_KEY = "agentTurnSteer" as const;

export const getAgentTurnSteerKey = (queuedTurnId: string) => `agent:turn:${queuedTurnId}:steer`;

export type AgentTurnSteerEvent = {
  id: string;
  spaceId: string;
  sessionId: string;
  activeTurnId: string;
  queuedTurnId: string;
  actorUserId: string | null;
  timestamp: number;
};

export type AgentTurnSteerEventInput = Omit<AgentTurnSteerEvent, "actorUserId" | "timestamp"> & {
  actorUserId?: string | null;
  timestamp?: number;
};

export function buildAgentTurnSteerEvent(input: AgentTurnSteerEventInput): AgentTurnSteerEvent {
  return {
    ...input,
    actorUserId: input.actorUserId ?? null,
    timestamp: input.timestamp ?? Date.now(),
  };
}

export type AgentTurnSteerFallbackReason = "active_turn_abort_requested" | "no_active_run";

export type CheckpointSteeringDecision =
  | { mode: "checkpoint"; targetTurnId: string }
  | { mode: "after_run"; targetTurnId: string | null; reason: AgentTurnSteerFallbackReason };

export function decideCheckpointSteering(input: {
  activeTurn: { id: string; status: "running" | "abort_requested" } | null;
}): CheckpointSteeringDecision {
  if (!input.activeTurn) {
    return { mode: "after_run", targetTurnId: null, reason: "no_active_run" };
  }
  if (input.activeTurn.status === "running") {
    return { mode: "checkpoint", targetTurnId: input.activeTurn.id };
  }
  return {
    mode: "after_run",
    targetTurnId: input.activeTurn.id,
    reason: "active_turn_abort_requested",
  };
}

export function decideSessionPromptSteering(input: {
  requestedIntent: "followup" | "steer";
  submittedTurnId: string;
  activeTurn: { id: string; status: "running" | "abort_requested" } | null;
}): CheckpointSteeringDecision | null {
  const activeTarget = input.activeTurn?.id !== input.submittedTurnId ? input.activeTurn : null;
  if (!activeTarget && input.requestedIntent === "followup") return null;
  return decideCheckpointSteering({ activeTurn: activeTarget });
}

export type AgentTurnSteerDelivery =
  | { mode: "checkpoint"; status: "pending"; targetTurnId: string }
  | {
      mode: "after_run";
      status: "pending";
      targetTurnId: string | null;
      reason: AgentTurnSteerFallbackReason;
    };

export function buildAgentTurnSteerMeta(decision: CheckpointSteeringDecision): {
  agentTurnSteer: AgentTurnSteerDelivery;
} {
  return {
    [AGENT_TURN_STEER_META_KEY]: { ...decision, status: "pending" },
  };
}
