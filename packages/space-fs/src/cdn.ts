import { basename } from "node:path";
import { createBullmqQueue, COHUB_SYSTEM_FS_QUEUE, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import {
  buildFsCdnFailKey,
  buildFsCdnJobId,
  buildFsCdnManifestKey,
  createFsCdnWarmJobsForChanges,
  FS_CDN_FAIL_TTL_SECONDS,
  FS_CDN_MANIFEST_TTL_SECONDS,
  shouldUseFsCdnCache,
  type FsCdnManifest,
  type FsCdnWarmFileJob,
  type FsCdnWarmReason,
} from "@cohub/core/fs-cdn";
import type { SpaceFsChange } from "@cohub/protocol/fs";
import type { SpaceFsFileResponse, SpaceFsPreparingFile } from "@cohub/protocol/fs";
import type { SpaceFsDeps } from "./types.js";

export type FsCdnFileMeta = {
  spaceId: string;
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

const FS_CDN_QUEUE_NAME = COHUB_SYSTEM_FS_QUEUE;
const FS_CDN_WARM_FILE_JOB = "cdn_cache.warm_file";
const FS_CDN_READ_WAIT_TIMEOUT_MS = 15_000;
const FS_CDN_READ_MANY_WAIT_TIMEOUT_MS = 5_000;
const FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS = 20_000;
const FS_CDN_POLL_INTERVAL_MS = 250;

export {
  FS_CDN_QUEUE_NAME,
  FS_CDN_WARM_FILE_JOB,
  FS_CDN_READ_WAIT_TIMEOUT_MS,
  FS_CDN_READ_MANY_WAIT_TIMEOUT_MS,
  FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS,
  FS_CDN_POLL_INTERVAL_MS,
  FS_CDN_MANIFEST_TTL_SECONDS,
  type FsCdnManifest,
  type FsCdnWarmFileJob,
  type FsCdnWarmReason,
};

export function shouldUseFsCdnForMeta(meta: Pick<FsCdnFileMeta, "path" | "mimeType" | "size">) {
  return shouldUseFsCdnCache(meta);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSpaceFsCdn(deps: SpaceFsDeps) {
  const { config, redis, serviceName } = deps;
  const logger = createLogger({ serviceName });

  const fsCdnQueue = createBullmqQueue(FS_CDN_QUEUE_NAME, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: `${serviceName}-fs-cdn`,
  });

  async function enqueueFsCdnWarmFile(payload: FsCdnWarmFileJob) {
    return fsCdnQueue.add(FS_CDN_WARM_FILE_JOB, payload, {
      jobId: buildFsCdnJobId({
        env: config.env,
        spaceId: payload.spaceId,
        path: payload.path,
        size: payload.size,
        mtimeMs: payload.mtimeMs,
      }),
      attempts: 2,
      backoff: { type: "exponential", delay: 2000 },
      ...defaultJobRetention,
    });
  }

  async function enqueueFsCdnWarmForChanges(spaceId: string, changes: SpaceFsChange[]) {
    await Promise.allSettled(
      createFsCdnWarmJobsForChanges({ spaceId, changes }).map(async (job) => {
        const failKey = buildFsCdnFailKey({
          env: config.env,
          spaceId: job.spaceId,
          path: job.path,
          size: job.size,
          mtimeMs: job.mtimeMs,
        });
        if (await redis.get(failKey)) return;
        await enqueueFsCdnWarmFile(job).catch(async (error) => {
          await redis
            .set(failKey, error instanceof Error ? error.message : String(error), "EX", FS_CDN_FAIL_TTL_SECONDS)
            .catch(() => undefined);
          throw error;
        });
      }),
    );
  }

  function parseManifest(value: string | null): FsCdnManifest | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as FsCdnManifest;
    } catch {
      return null;
    }
  }

  function isManifestFresh(manifest: FsCdnManifest | null, meta: FsCdnFileMeta) {
    return Boolean(manifest && manifest.path === meta.path && manifest.size === meta.size && manifest.mtimeMs === meta.mtimeMs);
  }

  async function getFsCdnManifest(meta: FsCdnFileMeta) {
    const key = buildFsCdnManifestKey({ env: config.env, spaceId: meta.spaceId, path: meta.path });
    const manifest = parseManifest(await redis.get(key));
    return isManifestFresh(manifest, meta) ? manifest : null;
  }

  async function getFreshFsCdnManifests(items: FsCdnFileMeta[]) {
    if (items.length === 0) return new Map<string, FsCdnManifest>();
    const keys = items.map((item) => buildFsCdnManifestKey({ env: config.env, spaceId: item.spaceId, path: item.path }));
    const values = await redis.mget(keys);
    const result = new Map<string, FsCdnManifest>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      const manifest = parseManifest(values[index] ?? null);
      if (isManifestFresh(manifest, item)) result.set(item.path, manifest as FsCdnManifest);
    }
    return result;
  }

  async function enqueueFsCdnWarmForMeta(meta: FsCdnFileMeta, reason: FsCdnWarmReason) {
    const failKey = buildFsCdnFailKey({
      env: config.env,
      spaceId: meta.spaceId,
      path: meta.path,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
    });
    if (await redis.get(failKey)) return;
    await enqueueFsCdnWarmFile({
      spaceId: meta.spaceId,
      path: meta.path,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      mimeType: meta.mimeType,
      requestedAt: Date.now(),
      reason,
    }).catch(async (error) => {
      await redis.set(failKey, error instanceof Error ? error.message : String(error), "EX", FS_CDN_FAIL_TTL_SECONDS).catch(() => undefined);
      throw error;
    });
  }

  async function waitForFsCdnManifests(items: FsCdnFileMeta[], timeoutMs: number) {
    const pending = new Map(items.map((item) => [item.path, item]));
    const ready = new Map<string, FsCdnManifest>();
    const deadline = Date.now() + timeoutMs;

    while (pending.size > 0 && Date.now() < deadline) {
      const metas = Array.from(pending.values());
      const manifests = await getFreshFsCdnManifests(metas);
      for (const [path, manifest] of manifests) {
        ready.set(path, manifest);
        pending.delete(path);
      }
      if (pending.size === 0) break;
      await sleep(Math.min(FS_CDN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    return { ready, pending: Array.from(pending.values()) };
  }

  async function ensureFsCdnManifest(meta: FsCdnFileMeta, reason: FsCdnWarmReason, timeoutMs: number) {
    const cached = await getFsCdnManifest(meta);
    if (cached) return cached;
    await enqueueFsCdnWarmForMeta(meta, reason);
    const failKey = buildFsCdnFailKey({
      env: config.env,
      spaceId: meta.spaceId,
      path: meta.path,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
    });
    if (await redis.get(failKey)) return null;
    const waited = await waitForFsCdnManifests([meta], timeoutMs);
    return waited.ready.get(meta.path) ?? null;
  }

  function buildUrlFileResponse(meta: FsCdnFileMeta, manifest: FsCdnManifest): SpaceFsFileResponse {
    return {
      path: meta.path,
      name: meta.name || basename(meta.path),
      size: meta.size,
      mimeType: meta.mimeType,
      mtimeMs: meta.mtimeMs,
      kind: "binary",
      encoding: "base64",
      content: "",
      delivery: "url",
      url: manifest.url,
    };
  }

  function buildPreparingFile(meta: FsCdnFileMeta, retryAfterMs = 2000): SpaceFsPreparingFile {
    return {
      path: meta.path,
      name: meta.name || basename(meta.path),
      size: meta.size,
      mimeType: meta.mimeType,
      mtimeMs: meta.mtimeMs,
      retryAfterMs,
    };
  }

  function getFsCdnManifestTtlSeconds() {
    return FS_CDN_MANIFEST_TTL_SECONDS;
  }

  logger.debug("[space-fs-cdn] initialized", { serviceName, env: config.env });

  return {
    shouldUseFsCdnForMeta,
    enqueueFsCdnWarmFile,
    enqueueFsCdnWarmForMeta,
    enqueueFsCdnWarmForChanges,
    ensureFsCdnManifest,
    waitForFsCdnManifests,
    getFreshFsCdnManifests,
    getFsCdnManifest,
    buildUrlFileResponse,
    buildPreparingFile,
    getFsCdnManifestTtlSeconds,
    fsCdnQueue,
  };
}

export type SpaceFsCdn = ReturnType<typeof createSpaceFsCdn>;
