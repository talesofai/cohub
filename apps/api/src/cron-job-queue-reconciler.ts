import type { RepeatableJob } from "bullmq";
import {
  findCronJobQueueEntries,
  indexCronJobQueueEntries,
  isCronJobQueueStateCurrent,
  type CronJobQueueExpectation,
  type CronJobQueueIndex,
} from "./cron-job-queue-state.js";

export type CronJobQueueRecord = CronJobQueueExpectation & {
  queueSyncedVersion: number;
};

export type CronJobQueueReconcilePort<T extends CronJobQueueRecord> = {
  load: (cronJobId: string) => Promise<T | null>;
  list: () => Promise<readonly RepeatableJob[]>;
  remove: (repeatJobKey: string) => Promise<unknown>;
  schedule: (cronJob: T) => Promise<string>;
  markSynced: (cronJob: T, repeatJobKey: string) => Promise<T | null>;
  createConflictError: () => Error;
  onConflictCleanupFailure?: (error: unknown, repeatJobKey: string) => void;
};

export async function reconcileCronJobQueueRecord<T extends CronJobQueueRecord>(
  cronJobId: string,
  port: CronJobQueueReconcilePort<T>,
  options: {
    verifyQueueState?: boolean;
    queueIndex?: CronJobQueueIndex;
  } = {},
) {
  const current = await port.load(cronJobId);
  if (!current) return null;

  let queueIndex = options.queueIndex ?? null;
  if (!queueIndex && (!current.enabled || current.deletedAt)) {
    queueIndex = indexCronJobQueueEntries(await port.list());
  }
  if (current.queueSyncedVersion === current.scheduleVersion) {
    if (!options.verifyQueueState) return current;
    queueIndex ??= indexCronJobQueueEntries(await port.list());
    if (isCronJobQueueStateCurrent(current, queueIndex)) return current;
  }

  const staleKeys = new Set<string>();
  if (current.bullJobKey) staleKeys.add(current.bullJobKey);
  if (queueIndex) {
    for (const entry of findCronJobQueueEntries(current, queueIndex)) {
      staleKeys.add(entry.key);
    }
  }
  await Promise.all([...staleKeys].map((key) => port.remove(key)));

  const nextRepeatJobKey = current.enabled && !current.deletedAt
    ? await port.schedule(current)
    : "";
  const synced = await port.markSynced(current, nextRepeatJobKey);
  if (synced) return synced;

  if (nextRepeatJobKey) {
    await port.remove(nextRepeatJobKey).catch((error) => {
      port.onConflictCleanupFailure?.(error, nextRepeatJobKey);
    });
  }
  throw port.createConflictError();
}
