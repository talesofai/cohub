export type CronJobExecutionState = {
  enabled: boolean;
  deletedAt: Date | null;
  bullJobKey: string;
  scheduleVersion: number;
  queueSyncedVersion: number;
};

export function getCronJobSkipReason(input: {
  payloadVersion: number | undefined;
  repeatJobKey: string | undefined;
  current: CronJobExecutionState | null;
}) {
  const { current } = input;
  if (!current) return "cron_job_not_found";
  if (!current.enabled || current.deletedAt) return "cron_job_disabled";

  if (input.payloadVersion !== undefined) {
    return Number.isSafeInteger(input.payloadVersion)
      && input.payloadVersion === current.scheduleVersion
      ? null
      : "stale_cron_schedule";
  }

  const legacyScheduleIsCurrent = current.queueSyncedVersion === current.scheduleVersion
    && Boolean(input.repeatJobKey)
    && input.repeatJobKey === current.bullJobKey;
  return legacyScheduleIsCurrent ? null : "stale_cron_schedule";
}
