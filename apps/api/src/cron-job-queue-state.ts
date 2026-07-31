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

export type CronJobQueueIndex = {
  byOwnerId: ReadonlyMap<string, readonly RepeatableJob[]>;
  byKey: ReadonlyMap<string, RepeatableJob>;
};

export const cronJobRepeatOwnerId = (cronJobId: string) => `cron-${cronJobId}`;

export const cronJobRepeatVersionedId = (
  cronJobId: string,
  scheduleVersion: number,
) => `${cronJobRepeatOwnerId(cronJobId)}-v${scheduleVersion}`;

const repeatJobOwnerId = (repeatJobId: string) =>
  repeatJobId.replace(/-v\d+$/, "");

export function indexCronJobQueueEntries(
  repeatableJobs: readonly RepeatableJob[],
): CronJobQueueIndex {
  const byOwnerId = new Map<string, RepeatableJob[]>();
  const byKey = new Map<string, RepeatableJob>();
  for (const job of repeatableJobs) {
    byKey.set(job.key, job);
    if (!job.id) continue;
    const ownerId = repeatJobOwnerId(job.id);
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
  return entry?.key === cronJob.bullJobKey
    && entry.id === cronJobRepeatVersionedId(cronJob.id, cronJob.scheduleVersion)
    && entry.name === cronJob.taskType
    && entry.pattern === cronJob.cronExpression
    && entry.tz === cronJob.timezone;
}
