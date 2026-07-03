export { createSpaceFsCdn, shouldUseFsCdnForMeta, FS_CDN_QUEUE_NAME, FS_CDN_WARM_FILE_JOB, FS_CDN_READ_WAIT_TIMEOUT_MS, FS_CDN_READ_MANY_WAIT_TIMEOUT_MS, FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS, FS_CDN_POLL_INTERVAL_MS, FS_CDN_MANIFEST_TTL_SECONDS, type SpaceFsCdn, type FsCdnFileMeta, type FsCdnManifest, type FsCdnWarmFileJob, type FsCdnWarmReason } from "./cdn.js";
export { createSpaceFsOps, SpaceFsError, spaceFsJsonError, assertSafeRelativePath, assertInsideRoot, sanitizeFileName, type SpaceFsOps, type SpaceFsVisibility } from "./space-fs.js";
export { createCheckpointFs, CheckpointFsError, checkpointFsJsonError, type CheckpointFs } from "./checkpoint-fs.js";
export { createSpaceUpload, type SpaceUpload, type SpaceUploadManifestEntry, type SpaceUploadDestination, type SpaceUploadManifest } from "./upload.js";
export { createSandboxBashQueue, AGENT_SANDBOX_BASH_JOB_NAME, type SandboxBashQueue, type SandboxBashUploadFile, type SandboxBashUploadJobData, type SandboxBashUploadJobResult } from "./sandbox-queue.js";
export { createSpaceEvents, type SpaceEvents } from "./events.js";
export { createFsRouter, createCheckpointFsRouter, type FsRouterAuth } from "./router.js";
export { getMimeType, isTextMime } from "./mime.js";
export { createSpaceGitignoreFilter, type SpaceGitignoreFilter } from "./ignore.js";
export { createPresignedGetObjectUrl, createPresignedPutObjectUrl, createPresignedPostObject, getBucketPublicEndpoint, buildPublicObjectUrl, cacheBuster, type PresignStorageConfig, type PresignedPostObject } from "./object-presign.js";
export type { SpaceFsDeps, SpaceFsConfig, Db } from "./types.js";

import { createSpaceFsCdn } from "./cdn.js";
import { createSpaceFsOps } from "./space-fs.js";
import { createCheckpointFs } from "./checkpoint-fs.js";
import { createSpaceUpload } from "./upload.js";
import { createSandboxBashQueue } from "./sandbox-queue.js";
import { createSpaceEvents } from "./events.js";
import type { SpaceFsDeps } from "./types.js";

/**
 * Aggregated factory that wires up every space-fs sub-module with shared deps.
 * Call once at app startup (api or fs-api), then re-export the returned helpers.
 */
export function createSpaceFsModule(deps: SpaceFsDeps) {
  const cdn = createSpaceFsCdn(deps);
  const spaceFs = createSpaceFsOps(deps, cdn);
  const checkpointFs = createCheckpointFs(deps);
  const upload = createSpaceUpload(deps);
  const sandboxBash = createSandboxBashQueue(deps);
  const events = createSpaceEvents(deps, cdn);

  return { cdn, spaceFs, checkpointFs, upload, sandboxBash, events };
}

export type SpaceFsModule = ReturnType<typeof createSpaceFsModule>;
