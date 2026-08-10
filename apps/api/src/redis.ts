import { Redis } from "ioredis";
import { config } from "./config.js";

export const redisCommandClient = new Redis(config.redisUrl, { disableClientInfo: true });

/** Best-effort analytics writes must never queue behind a Redis outage. */
export const redisBestEffortCommandClient = new Redis(config.redisUrl, {
  commandTimeout: 250,
  disableClientInfo: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
redisBestEffortCommandClient.on("error", () => undefined);

export const isRedisReady = async () => {
  try {
    const pong = await redisCommandClient.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
};

export const getAgentInstanceInputQueueKey = (instanceId: string) =>
  `agent:instance:${instanceId}:input_queue`;

export const getGatewayNodeOutboundStreamKey = (nodeId: string) => `stream:gateway:node:${nodeId}:outbound`;
export { REALTIME_OUTBOUND_CHANNEL } from "@cohub/protocol/realtime";

export const xaddWithMaxlen = async (client: Redis, streamKey: string, ...args: (string | number)[]) => {
  return client.xadd(streamKey, "MAXLEN", "~", 2000, ...args);
};
