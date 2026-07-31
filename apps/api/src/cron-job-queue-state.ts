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

const repeatJobId = (cronJobId: string) => `cron-${cronJobId}`;

export function findCronJobQueueEntries(
  cronJob: Pick<CronJobQueueExpectation, "id" | "bullJobKey">,
  repeatableJobs: readonly RepeatableJob[],
) {
  const jobId = repeatJobId(cronJob.id);
  return repeatableJobs.filter((job) =>
    job.id === jobId || Boolean(cronJob.bullJobKey && job.key === cronJob.bullJobKey),
  );
}

export function isCronJobQueueStateCurrent(
  cronJob: CronJobQueueExpectation,
  repeatableJobs: readonly RepeatableJob[],
) {
  const entries = findCronJobQueueEntries(cronJob, repeatableJobs);
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
