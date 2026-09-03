import { randomUUID } from "node:crypto";
import type { SpaceFsUploadTargetVersion } from "@cohub/protocol/fs";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import { createUserUploadGetUrl, createUserUploadPutUrl } from "./user-upload-storage.js";

const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
export const MAX_SPACE_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_SPACE_UPLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SPACE_UPLOAD_FILES = 1000;
/** Allows ten full-size batches while replenishing sustained usage at 3,000 entries/hour. */
const SPACE_UPLOAD_QUOTA_CAPACITY = 10_000;
const SPACE_UPLOAD_QUOTA_REFILL_PER_HOUR = 3_000;
const SPACE_UPLOAD_QUOTA_REFILL_PERIOD_SECONDS = 60 * 60;

const CONSUME_UPLOAD_QUOTA_SCRIPT = `
local requested = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_per_second = tonumber(ARGV[3])
local state_ttl = tonumber(ARGV[4])
local legacy_window = tonumber(ARGV[5])
local now_parts = redis.call("TIME")
local now = tonumber(now_parts[1]) + tonumber(now_parts[2]) / 1000000
local key_type = redis.call("TYPE", KEYS[1])
if type(key_type) == "table" then key_type = key_type["ok"] end

local tokens = capacity
local updated_at = now
if key_type == "hash" then
  local state = redis.call("HMGET", KEYS[1], "tokens", "updated_at", "capacity")
  local previous_capacity = tonumber(state[3]) or capacity
  tokens = math.max(0, math.min(capacity, (tonumber(state[1]) or previous_capacity) + capacity - previous_capacity))
  updated_at = tonumber(state[2]) or now
elseif key_type == "string" then
  local legacy_used = tonumber(redis.call("GET", KEYS[1])) or 0
  local legacy_ttl = redis.call("TTL", KEYS[1])
  local legacy_elapsed = legacy_ttl >= 0 and math.max(0, legacy_window - legacy_ttl) or 0
  tokens = math.min(capacity, math.max(0, capacity - legacy_used) + legacy_elapsed * refill_per_second)
  redis.call("DEL", KEYS[1])
elseif key_type ~= "none" then
  return redis.error_reply("unsupported space upload quota key type")
end

tokens = math.min(capacity, tokens + math.max(0, now - updated_at) * refill_per_second)
redis.call("HSET", KEYS[1], "tokens", tokens, "updated_at", now, "capacity", capacity)
redis.call("EXPIRE", KEYS[1], state_ttl)

if requested > tokens then
  return {0, math.ceil((requested - tokens) / refill_per_second)}
end

redis.call("HSET", KEYS[1], "tokens", tokens - requested)
return {1, 0}
`;

export class SpaceUploadRateLimitError extends Error {
  override name = "SpaceUploadRateLimitError";
  constructor(
    public readonly retryAfterSeconds: number,
    message = "too many uploads, please try again later",
  ) {
    super(message);
  }
}

export type SpaceUploadManifestEntry = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string | null;
  /** Private staging object when client PUTs. Absent when entry is remote (downloadUrl). */
  objectKey?: string;
  /** Durable public URL already uploaded elsewhere; complete pulls from this. */
  downloadUrl?: string;
  /** Target version captured before the client began uploading. */
  targetVersion?: SpaceFsUploadTargetVersion;
};

export type SpaceUploadDestination =
  | { kind: "workspace"; targetDir?: string }
  | { kind: "sandbox_tmp"; sessionId?: string };

export type SpaceUploadManifest = {
  uploadId: string;
  spaceId: string;
  userId: string;
  destination: SpaceUploadDestination;
  entries: SpaceUploadManifestEntry[];
  createdAt: string;
  expiresAt: string;
};

export const createSpaceUploadId = () => randomUUID();

/**
 * Per-user rate limit for space file uploads (workspace + sandbox_tmp).
 * Counts planned file entries, not request batches — more accurate against bulk abuse.
 */
export const consumeSpaceUploadQuota = async (userId: string, entryCount: number) => {
  const count = Math.max(0, Math.floor(entryCount));
  if (count <= 0) return;
  const key = `space_upload:${userId}`;
  const refillPerSecond = SPACE_UPLOAD_QUOTA_REFILL_PER_HOUR / SPACE_UPLOAD_QUOTA_REFILL_PERIOD_SECONDS;
  const stateTtlSeconds = Math.ceil(SPACE_UPLOAD_QUOTA_CAPACITY / refillPerSecond);
  const result = await redisCommandClient.eval(
    CONSUME_UPLOAD_QUOTA_SCRIPT,
    1,
    key,
    count,
    SPACE_UPLOAD_QUOTA_CAPACITY,
    refillPerSecond,
    stateTtlSeconds,
    SPACE_UPLOAD_QUOTA_REFILL_PERIOD_SECONDS,
  ) as [number, number];
  if (result[0] !== 1) throw new SpaceUploadRateLimitError(Math.max(1, result[1]));
};

export const buildSpaceUploadObjectKey = (input: { spaceId: string; uploadId: string; entryId: string }) => {
  const envPrefix = config.env === "prod" ? "" : `${config.env}/`;
  return `${envPrefix}uploads/${input.spaceId}/${input.uploadId}/${input.entryId}`;
};

const manifestKey = (spaceId: string, uploadId: string) => `space:fs:upload:${spaceId}:${uploadId}`;
const completeKey = (spaceId: string, uploadId: string) => `space:fs:upload:complete:${spaceId}:${uploadId}`;

export const saveSpaceUploadManifest = async (manifest: SpaceUploadManifest) => {
  await redisCommandClient.set(
    manifestKey(manifest.spaceId, manifest.uploadId),
    JSON.stringify(manifest),
    "EX",
    UPLOAD_TTL_SECONDS,
  );
};

export const getSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
  const raw = await redisCommandClient.get(manifestKey(spaceId, uploadId));
  return raw ? JSON.parse(raw) as SpaceUploadManifest : null;
};

export const deleteSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
  await redisCommandClient.del(manifestKey(spaceId, uploadId));
};

export const beginSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
  const key = completeKey(spaceId, uploadId);
  const ok = await redisCommandClient.set(key, "pending", "EX", UPLOAD_TTL_SECONDS, "NX");
  if (ok === "OK") return { acquired: true as const };
  return { acquired: false as const, taskRunId: await redisCommandClient.get(key) };
};

export const finishSpaceUploadComplete = async (spaceId: string, uploadId: string, taskRunId: string) => {
  await redisCommandClient.set(completeKey(spaceId, uploadId), taskRunId, "EX", UPLOAD_TTL_SECONDS);
};

export const cancelSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
  const key = completeKey(spaceId, uploadId);
  const value = await redisCommandClient.get(key);
  if (value === "pending") await redisCommandClient.del(key);
};

export const createPresignedPutUrl = (
  objectKey: string,
  contentType: string | null | undefined,
  contentLength: number,
) =>
  createUserUploadPutUrl({
    kind: "space_upload",
    objectKey,
    contentType,
    contentLength,
  });

export const createPresignedGetUrl = (objectKey: string) =>
  createUserUploadGetUrl("space_upload", objectKey);
