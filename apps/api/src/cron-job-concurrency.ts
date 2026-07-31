export const CRON_JOB_CONFLICT_CODE = "cron_job_conflict";

export class CronJobUpdateVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronJobUpdateVersionError";
  }
}

export class CronJobUpdateConflictError extends Error {
  readonly code = CRON_JOB_CONFLICT_CODE;

  constructor() {
    super("This scheduled prompt changed elsewhere. Reload it and apply your changes again.");
    this.name = "CronJobUpdateConflictError";
  }
}

export function parseCronJobExpectedUpdatedAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CronJobUpdateVersionError("expectedUpdatedAt is required");
  }
  const expectedUpdatedAt = new Date(value);
  if (Number.isNaN(expectedUpdatedAt.getTime())) {
    throw new CronJobUpdateVersionError("expectedUpdatedAt must be an ISO timestamp");
  }
  return expectedUpdatedAt;
}

export function assertCronJobUpdateVersion(
  currentUpdatedAt: Date | null,
  expectedUpdatedAt: Date,
) {
  if (
    !currentUpdatedAt ||
    currentUpdatedAt.getTime() !== expectedUpdatedAt.getTime()
  ) {
    throw new CronJobUpdateConflictError();
  }
}

export function nextCronJobUpdateVersion(currentUpdatedAt: Date | null) {
  return new Date(
    Math.max(Date.now(), (currentUpdatedAt?.getTime() ?? 0) + 1),
  );
}
