import { decodeWorkViewStatsRedisField } from "@cohub/protocol";

export type WorkViewStatsBatchRow = {
  workId: string;
  workVersionId: string;
  bucketStartAt: Date;
  source: string;
  viewCount: number;
  updatedAt: Date;
};

export function parseWorkViewStatsBatch(
  hash: Record<string, string>,
  now = new Date(),
): { rows: WorkViewStatsBatchRow[]; invalid: number } {
  const rows: WorkViewStatsBatchRow[] = [];
  let invalid = 0;
  for (const [field, rawCount] of Object.entries(hash)) {
    const dimensions = decodeWorkViewStatsRedisField(field);
    const viewCount = Number(rawCount);
    if (!dimensions || !Number.isSafeInteger(viewCount) || viewCount <= 0) {
      invalid += 1;
      continue;
    }
    rows.push({
      workId: dimensions.workId,
      workVersionId: dimensions.workVersionId,
      bucketStartAt: new Date(dimensions.bucketStartAtMs),
      source: dimensions.source,
      viewCount,
      updatedAt: now,
    });
  }
  return { rows, invalid };
}
