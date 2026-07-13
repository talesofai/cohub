import { createHash, randomUUID } from "node:crypto";

export function createWorkAssetCleanupJobId(assetKeys: string[], nonce = randomUUID()) {
  const digest = createHash("sha256").update(assetKeys.slice().sort().join("\n")).digest("hex").slice(0, 24);
  return `work-asset-cleanup-${digest}-${nonce}`;
}
