import type { RepeatableJob } from "bullmq";

export type CronJobQueueExpectation = {
  id: string;
  taskType: string;
  cronExpression: string;
  timezone: string;
  bullJobKey: string;
  enabled: boolean;
  deletedAt: Date | null;
};

export type CronJobQueueIndex = {
  byId: ReadonlyMap<string, readonly RepeatableJob[]>;
  byKey: ReadonlyMap<string, RepeatableJob>;
};

const repeatJobId = (cronJobId: string) => `cron-${cronJobId}`;

export function indexCronJobQueueEntries(
  repeatableJobs: readonly RepeatableJob[],
): CronJobQueueIndex {
  const byId = new Map<string, RepeatableJob[]>();
  const byKey = new Map<string, RepeatableJob>();
  for (const job of repeatableJobs) {
    byKey.set(job.key, job);
    if (!job.id) continue;
    const entries = byId.get(job.id);
    if (entries) entries.push(job);
    else byId.set(job.id, [job]);
  }
  return { byId, byKey };
}

export function findCronJobQueueEntries(
  cronJob: Pick<CronJobQueueExpectation, "id" | "bullJobKey">,
  queueIndex: CronJobQueueIndex,
) {
  const jobId = repeatJobId(cronJob.id);
  const entries = [...(queueIndex.byId.get(jobId) ?? [])];
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
    && entry.id === repeatJobId(cronJob.id)
    && entry.name === cronJob.taskType
    && entry.pattern === cronJob.cronExpression
    && entry.tz === cronJob.timezone;
}
