import { createHash, randomUUID } from "node:crypto";
import type { WorkPublishAssetJobResult } from "./work-publish-asset-queue.js";
import type { WorkAssetKeyScope } from "./routes/work-delete.js";

const VERSION_SEGMENT_RE = /^[a-f0-9]{12}$/;

export function createWorkAssetCleanupScope(
  env: WorkAssetKeyScope["env"],
  work: { spaceId: string; slug: string },
): WorkAssetKeyScope {
  return { env, spaceId: work.spaceId, slug: work.slug };
}

export function createWorkAssetObjectKey(
  env: WorkAssetKeyScope["env"],
  work: { spaceId: string; slug: string },
  versionSegment = randomUUID().replaceAll("-", "").slice(0, 12),
) {
  if (!VERSION_SEGMENT_RE.test(versionSegment)) throw new Error("invalid work asset version segment");
  const envPrefix = env === "prod" ? "" : `${env}/`;
  return `${envPrefix}w/${work.spaceId}/${work.slug}/${versionSegment}/index.html`;
}

export function createWorkAssetPublishJobId(assetKey: string, nonce = randomUUID()) {
  const digest = createHash("sha256").update(assetKey).digest("hex").slice(0, 24);
  return `work-publish-asset-${digest}-${nonce}`;
}

export function selectWorkAssetCleanupKey(
  assetKey: string | null,
  failure: Extract<WorkPublishAssetJobResult, { ok: false }> | null,
) {
  return failure?.cleanupAssetKey ?? assetKey ?? null;
}
