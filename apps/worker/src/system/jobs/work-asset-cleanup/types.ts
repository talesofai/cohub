export const WORK_ASSET_CLEANUP_JOB = "work.cleanup_asset";

export type WorkAssetCleanupJobData = {
  assetKeys: string[];
  scope: {
    env: "dev" | "prod";
    spaceId: string;
    slug: string;
  };
  reason: string;
  publishJobId?: string;
  deferWhileReferenced?: boolean;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};
