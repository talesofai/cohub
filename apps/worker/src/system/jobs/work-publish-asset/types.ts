export const WORK_PUBLISH_ASSET_JOB = "work.publish_asset";

export type WorkPublishAssetJobData = {
  spaceId: string;
  slug: string;
  assetKey?: string;
  targetType: "file" | "directory";
  targetRef: string;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type WorkPublishAssetJobResult = {
  ok: true;
  assetKey: string;
  sizeBytes: number;
  fileCount?: number;
} | {
  ok: false;
  status: number;
  message: string;
  code?: string;
  cleanupAssetKey?: string;
};
