import { redisCommandClient } from "../../redis.js";

const CONTEXT_TOKEN_MAX_PEERS = 5000;
const CONTEXT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEDUP_TTL_SECONDS = 60 * 60 * 24;
const SYNC_BUF_TTL_SECONDS = 60 * 60 * 24 * 90;
const STATUS_TTL_SECONDS = 60 * 60 * 24 * 30;

export type WeChatStatusField = "lastPollAt" | "lastInboundAt" | "lastOutboundAt" | "lastErrorAt" | "lastError";

const syncBufKey = (channelId: string) => `gateway:wechat:${channelId}:sync_buf`;
const contextTokenKey = (channelId: string) => `gateway:wechat:${channelId}:context_tokens`;
const contextTokenIndexKey = (channelId: string) => `gateway:wechat:${channelId}:context_token_index`;
const dedupKey = (channelId: string, externalMessageId: string) => `gateway:wechat:${channelId}:dedup:${externalMessageId}`;
const statusKey = (channelId: string) => `gateway:wechat:${channelId}:status`;

export async function getWeChatSyncBuf(channelId: string) {
  return (await redisCommandClient.get(syncBufKey(channelId))) ?? "";
}

export async function setWeChatSyncBuf(channelId: string, value: string) {
  if (!value) return;
  await redisCommandClient.set(syncBufKey(channelId), value, "EX", SYNC_BUF_TTL_SECONDS);
}

export async function getWeChatContextToken(channelId: string, externalChatId: string) {
  const peer = externalChatId.trim();
  if (!peer) return null;
  return (await redisCommandClient.hget(contextTokenKey(channelId), peer))?.trim() || null;
}

export async function setWeChatContextToken(channelId: string, externalChatId: string, contextToken: string) {
  const peer = externalChatId.trim();
  const token = contextToken.trim();
  if (!peer || !token) return;

  const now = Date.now();
  const tokenKey = contextTokenKey(channelId);
  const indexKey = contextTokenIndexKey(channelId);
  await redisCommandClient
    .multi()
    .hset(tokenKey, peer, token)
    .zadd(indexKey, String(now), peer)
    .expire(tokenKey, CONTEXT_TOKEN_TTL_SECONDS)
    .expire(indexKey, CONTEXT_TOKEN_TTL_SECONDS)
    .exec();

  const overflow = await redisCommandClient.zcard(indexKey) - CONTEXT_TOKEN_MAX_PEERS;
  if (overflow > 0) {
    const stalePeers = await redisCommandClient.zrange(indexKey, 0, String(overflow - 1));
    if (stalePeers.length > 0) {
      await redisCommandClient.multi().hdel(tokenKey, ...stalePeers).zrem(indexKey, ...stalePeers).exec();
    }
  }
}

export async function reserveWeChatMessage(channelId: string, externalMessageId: string) {
  const key = dedupKey(channelId, externalMessageId);
  const result = await redisCommandClient.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseWeChatMessageReservation(channelId: string, externalMessageId: string) {
  await redisCommandClient.del(dedupKey(channelId, externalMessageId));
}

export async function updateWeChatStatus(channelId: string, fields: Partial<Record<WeChatStatusField, string | number>>) {
  const entries = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null)
    .flatMap(([key, value]) => [key, String(value)]);
  if (entries.length === 0) return;
  await redisCommandClient.multi().hset(statusKey(channelId), ...entries).expire(statusKey(channelId), STATUS_TTL_SECONDS).exec();
}
