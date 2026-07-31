import type { RepeatableJob } from "bullmq";

export type CronJobQueueExpectation = {
  id: string;
  taskType: string;
  cronExpression: string;
  timezone: string;
  bullJobKey: string;
  enabled: boolean;
  deletedAt: Date | null;
  scheduleVersion: number;
};

export type CronJobQueueSyncStatus = "synced" | "pending";

export type CronJobQueueIndex = {
  byOwnerId: ReadonlyMap<string, readonly RepeatableJob[]>;
  byKey: ReadonlyMap<string, RepeatableJob>;
};

export const cronJobRepeatOwnerId = (cronJobId: string) => `cron-${cronJobId}`;

export const cronJobRepeatVersionedId = (
  cronJobId: string,
  scheduleVersion: number,
) => `${cronJobRepeatOwnerId(cronJobId)}-v${scheduleVersion}`;

const repeatJobOwnerId = (repeatJobKey: string) =>
  repeatJobKey.match(/^(cron-.+)-v\d+$/)?.[1] ?? null;

export const cronJobQueueSyncStatus = (
  cronJob: Pick<CronJobQueueExpectation, "scheduleVersion"> & {
    queueSyncedVersion: number;
  },
): CronJobQueueSyncStatus =>
  cronJob.queueSyncedVersion === cronJob.scheduleVersion ? "synced" : "pending";

export function indexCronJobQueueEntries(
  repeatableJobs: readonly RepeatableJob[],
): CronJobQueueIndex {
  const byOwnerId = new Map<string, RepeatableJob[]>();
  const byKey = new Map<string, RepeatableJob>();
  for (const job of repeatableJobs) {
    byKey.set(job.key, job);
    const ownerId = repeatJobOwnerId(job.key);
    if (!ownerId) continue;
    const entries = byOwnerId.get(ownerId);
    if (entries) entries.push(job);
    else byOwnerId.set(ownerId, [job]);
  }
  return { byOwnerId, byKey };
}

export function findCronJobQueueEntries(
  cronJob: Pick<CronJobQueueExpectation, "id" | "bullJobKey">,
  queueIndex: CronJobQueueIndex,
) {
  const ownerId = cronJobRepeatOwnerId(cronJob.id);
  const entries = [...(queueIndex.byOwnerId.get(ownerId) ?? [])];
  const storedEntry = cronJob.bullJobKey
    ? queueIndex.byKey.get(cronJob.bullJobKey)
    : undefined;
  if (storedEntry && !entries.some((entry) => entry.key === storedEntry.key)) {
    entries.push(storedEntry);
  }
  return entries;
}

export function isCronJobQueueStateCurrent(
  cronJob: CronJobQueueExpectation,
  queueIndex: CronJobQueueIndex,
) {
  const entries = findCronJobQueueEntries(cronJob, queueIndex);
  if (!cronJob.enabled || cronJob.deletedAt) {
    return cronJob.bullJobKey === "" && entries.length === 0;
  }
  if (!cronJob.bullJobKey || entries.length !== 1) return false;

  const [entry] = entries;
  const expectedKey = cronJobRepeatVersionedId(
    cronJob.id,
    cronJob.scheduleVersion,
  );
  return entry?.key === cronJob.bullJobKey
    && entry.key === expectedKey
    && entry.name === cronJob.taskType
    && entry.pattern === cronJob.cronExpression
    && entry.tz === cronJob.timezone;
}
