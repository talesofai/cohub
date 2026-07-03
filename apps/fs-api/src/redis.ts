import { Redis } from "ioredis";
import { config } from "./config.js";

export const redisCommandClient = new Redis(config.redisUrl);

export { REALTIME_OUTBOUND_CHANNEL } from "@cohub/protocol/realtime";
