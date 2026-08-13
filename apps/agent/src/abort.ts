import { Redis } from "ioredis";
import { env } from "./env.js";
import { redis } from "./redis.js";
import { createLogger } from "@cohub/infra/logging";
import { AGENT_TURN_STEER_CHANNEL, type AgentTurnSteerEvent } from "@cohub/core/sessions";


const logger = createLogger({ serviceName: "cohub-agent" });
export const AGENT_TURN_ABORT_CHANNEL = "pubsub:agent:turn_abort";
export const getAgentTurnAbortKey = (turnId: string) => `agent:turn:${turnId}:abort`;

export type AgentTurnAbortEvent = {
  id: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  reason: "abort" | "interrupt";
  continuedByTurnId?: string | null;
  actorUserId?: string | null;
  timestamp: number;
};

const subscriber = new Redis(env.REDIS_URL, { disableClientInfo: true });

export async function subscribeAbortEvents(input: {
  onTurnAbort: (event: AgentTurnAbortEvent) => void;
  onTurnSteer: (event: AgentTurnSteerEvent) => void | Promise<void>;
}) {
  await subscriber.subscribe(AGENT_TURN_ABORT_CHANNEL, AGENT_TURN_STEER_CHANNEL);
  subscriber.on("message", (channel, raw) => {
    try {
      if (channel === AGENT_TURN_ABORT_CHANNEL) {
        const event = JSON.parse(raw) as AgentTurnAbortEvent;
        if (event?.turnId) input.onTurnAbort(event);
        return;
      }
      if (channel === AGENT_TURN_STEER_CHANNEL) {
        const event = JSON.parse(raw) as AgentTurnSteerEvent;
        if (event?.spaceId && event?.sessionId && event?.queuedTurnId && event?.activeTurnId) {
          void Promise.resolve(input.onTurnSteer(event)).catch((error) => {
            logger.warn("[AgentSteer] failed to handle steer event", error);
          });
        }
      }
    } catch (error) {
      logger.warn("[AgentRuntime] invalid runtime event", error);
    }
  });
}

export async function getAbortEvent(turnId: string): Promise<AgentTurnAbortEvent | null> {
  const raw = await redis.get(getAgentTurnAbortKey(turnId)).catch(() => null);
  if (!raw) return null;
  try {
    const event = JSON.parse(raw) as AgentTurnAbortEvent;
    return event?.turnId === turnId ? event : null;
  } catch {
    return null;
  }
}

export async function isAbortRequested(turnId: string) {
  return Boolean(await getAbortEvent(turnId));
}

export async function closeAbortSubscriber() {
  await subscriber.quit();
}
