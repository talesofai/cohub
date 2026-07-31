import { COHUB_TASKS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { enqueueTaskRun } from "@cohub/core/tasks";
import { and, eq, gt, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { cronJobs } from "@cohub/db";
import type { TaskPayload, TaskScheduleConfig } from "@cohub/protocol/task";
import { GENERATION_TASK_TYPE } from "@cohub/protocol/generation";
import { dispatchTaskCreated } from "./realtime-events.js";
import { redisCommandClient } from "./redis.js";
import { createLogger } from "@cohub/infra/logging";
import {
  assertCronJobUpdateVersion,
  CronJobUpdateConflictError,
  nextCronJobUpdateVersion,
} from "./cron-job-concurrency.js";
import {
  cronJobRepeatVersionedId,
  findCronJobQueueEntries,
  indexCronJobQueueEntries,
  isCronJobQueueStateCurrent,
  type CronJobQueueIndex,
} from "./cron-job-queue-state.js";


const logger = createLogger({ serviceName: "cohub-api" });
type TaskEnqueueOptions = Omit<JobsOptions, "scheduledAt"> & { scheduledAt?: Date | null };

const QUEUE_NAME = COHUB_TASKS_QUEUE;

export const taskQueue = createBullmqQueue(QUEUE_NAME, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api",
});

export const SUPPORTED_TASK_TYPES = new Set<string>(["send_message", "save_checkpoint", "create_space", "run_command", "space_hook", GENERATION_TASK_TYPE]);

export const enqueueTask = async (
  payload: TaskPayload,
  opts?: TaskEnqueueOptions,
) => enqueueTaskRun({
  db,
  payload,
  options: opts,
  enqueue: (name, taskPayload, options) => taskQueue.add(name, taskPayload, options),
  onTaskCreated: (taskRun) => dispatchTaskCreated(taskRun).catch((error) => {
    logger.warn("[Realtime] failed to dispatch task.created", error);
  }),
});

export const createCronJob = async (params: {
  userId: string;
  title: string;
  taskType: string;
  payload: Record<string, unknown>;
  schedule: TaskScheduleConfig;
  spaceId?: string | null;
  sessionId?: string | null;
}) => {
  const cronJobResult = await db.insert(cronJobs).values({
    userUuid: params.userId,
    title: params.title,
    taskType: params.taskType,
    payload: params.payload,
    cronExpression: params.schedule.pattern,
    timezone: params.schedule.timezone ?? "Asia/Shanghai",
    bullJobKey: "",
    spaceId: params.spaceId ?? null,
    sessionId: params.sessionId ?? null,
  }).returning();

  const cronJob = cronJobResult[0];
  if (!cronJob) throw new Error("Failed to create cron job record");

  return await reconcileCronJobQueue(cronJob.id).catch((error) => {
    logCronJobQueueSyncFailure(cronJob.id)(error);
    return cronJob;
  }) ?? cronJob;
};

const cronJobUpdateCondition = (
  cronJobId: string,
  expectedUpdatedAt: Date | null,
) => {
  const expectedVersion = expectedUpdatedAt
    ? and(
        gte(cronJobs.updatedAt, expectedUpdatedAt),
        lt(cronJobs.updatedAt, new Date(expectedUpdatedAt.getTime() + 1)),
      )
    : isNull(cronJobs.updatedAt);
  return and(
    eq(cronJobs.id, cronJobId),
    expectedVersion,
    isNull(cronJobs.deletedAt),
  );
};

type CronJobScheduleData = {
  taskType: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  userUuid: string;
  spaceId?: string | null;
  sessionId?: string | null;
  scheduleVersion: number;
};

async function scheduleCronJobRepeat(
  cronJobId: string,
  jobData: CronJobScheduleData,
) {
  const taskPayload: TaskPayload = {
    type: jobData.taskType,
    spaceId: jobData.spaceId ?? undefined,
    sessionId: jobData.sessionId ?? undefined,
    userId: jobData.userUuid,
    data: jobData.payload,
    cronJobId,
    cronJobVersion: jobData.scheduleVersion,
  };

  const job = await taskQueue.add(
    jobData.taskType,
    taskPayload,
    {
      repeat: {
        key: cronJobRepeatVersionedId(cronJobId, jobData.scheduleVersion),
        pattern: jobData.cronExpression,
        tz: jobData.timezone,
      },
      jobId: cronJobRepeatVersionedId(cronJobId, jobData.scheduleVersion),
      ...defaultJobRetention,
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
    },
  );

  const repeatJobKey = job.repeatJobKey;
  if (!repeatJobKey) throw new Error("Failed to get repeat job key");
  return repeatJobKey;
}

const cronJobScheduleData = (job: CronJobRow): CronJobScheduleData => ({
  taskType: job.taskType,
  payload: job.payload as Record<string, unknown>,
  cronExpression: job.cronExpression,
  timezone: job.timezone,
  userUuid: job.userUuid,
  spaceId: job.spaceId,
  sessionId: job.sessionId,
  scheduleVersion: job.scheduleVersion,
});

type CronJobRow = typeof cronJobs.$inferSelect;

export async function reconcileCronJobQueue(
  cronJobId: string,
  options: {
    verifyQueueState?: boolean;
    queueIndex?: CronJobQueueIndex;
  } = {},
) {
  const [current] = await db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.id, cronJobId))
    .limit(1);
  if (!current) return null;

  let queueIndex = options.queueIndex ?? null;
  if (!queueIndex && (!current.enabled || current.deletedAt)) {
    queueIndex = indexCronJobQueueEntries(
      await taskQueue.getRepeatableJobs(0, -1, true),
    );
  }
  if (current.queueSyncedVersion === current.scheduleVersion) {
    if (!options.verifyQueueState) return current;
    queueIndex ??= indexCronJobQueueEntries(
      await taskQueue.getRepeatableJobs(0, -1, true),
    );
    if (isCronJobQueueStateCurrent(current, queueIndex)) return current;
  }

  const staleKeys = new Set<string>();
  if (current.bullJobKey) staleKeys.add(current.bullJobKey);
  if (queueIndex) {
    for (const entry of findCronJobQueueEntries(current, queueIndex)) {
      staleKeys.add(entry.key);
    }
  }
  await Promise.all([...staleKeys].map((key) => taskQueue.removeRepeatableByKey(key)));

  const nextBullJobKey = current.enabled && !current.deletedAt
    ? await scheduleCronJobRepeat(current.id, cronJobScheduleData(current))
    : "";

  const [synced] = await db
    .update(cronJobs)
    .set({
      bullJobKey: nextBullJobKey,
      queueSyncedVersion: current.scheduleVersion,
    })
    .where(and(
      eq(cronJobs.id, current.id),
      eq(cronJobs.scheduleVersion, current.scheduleVersion),
    ))
    .returning();
  if (!synced) {
    if (nextBullJobKey) {
      await taskQueue.removeRepeatableByKey(nextBullJobKey).catch((cleanupError) => {
        logger.warn("[CronJob] failed to remove stale versioned repeat", {
          cronJobId,
          repeatJobKey: nextBullJobKey,
          cleanupError,
        });
      });
    }
    throw new CronJobUpdateConflictError();
  }
  return synced;
}

const logCronJobQueueSyncFailure = (cronJobId: string) => (error: unknown) => {
  logger.error("[CronJob] queue sync remains pending", {
    cronJobId,
    error,
  });
};

export const removeCronJob = async (cronJobId: string) => {
  const deletedJob = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${cronJobId}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
      .limit(1);
    if (!current) throw new CronJobUpdateConflictError();

    const [deleted] = await tx
      .update(cronJobs)
      .set({
        deletedAt: new Date(),
        enabled: false,
        scheduleVersion: current.scheduleVersion + 1,
        updatedAt: nextCronJobUpdateVersion(current.updatedAt),
      })
      .where(cronJobUpdateCondition(current.id, current.updatedAt))
      .returning();
    if (!deleted) throw new CronJobUpdateConflictError();
    return deleted;
  });

  await reconcileCronJobQueue(cronJobId).catch(logCronJobQueueSyncFailure(cronJobId));
  return deletedJob;
};

type CronJobUpdatePatch = {
  title?: string;
  payload?: Record<string, unknown>;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export const updateCronJob = async (
  snapshot: CronJobRow,
  patch: CronJobUpdatePatch,
) => {
  const { updatedJob, scheduleChanged } = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.id}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.id, snapshot.id), isNull(cronJobs.deletedAt)))
      .limit(1);
    if (!current) throw new CronJobUpdateConflictError();
    assertCronJobUpdateVersion(
      current.updatedAt,
      snapshot.updatedAt ?? new Date(0),
    );

    const scheduleChanged =
      patch.payload !== undefined ||
      patch.cronExpression !== undefined ||
      patch.timezone !== undefined ||
      (patch.enabled !== undefined && patch.enabled !== current.enabled);

    const [updatedJob] = await tx
      .update(cronJobs)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.cronExpression !== undefined
          ? { cronExpression: patch.cronExpression }
          : {}),
        ...(patch.timezone !== undefined
          ? { timezone: patch.timezone }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(scheduleChanged
          ? { scheduleVersion: current.scheduleVersion + 1 }
          : {}),
        updatedAt: nextCronJobUpdateVersion(current.updatedAt),
      })
      .where(cronJobUpdateCondition(current.id, current.updatedAt))
      .returning();
    if (!updatedJob) throw new CronJobUpdateConflictError();
    return { updatedJob, scheduleChanged };
  });

  if (scheduleChanged) {
    return await reconcileCronJobQueue(snapshot.id).catch((error) => {
      logCronJobQueueSyncFailure(snapshot.id)(error);
      return updatedJob;
    }) ?? updatedJob;
  }
  return updatedJob;
};

export async function reconcilePendingCronJobQueues(limit = 100) {
  const pending = await db
    .select({ id: cronJobs.id })
    .from(cronJobs)
    .where(ne(cronJobs.queueSyncedVersion, cronJobs.scheduleVersion))
    .orderBy(cronJobs.updatedAt, cronJobs.id)
    .limit(limit);

  let failed = 0;
  for (const candidate of pending) {
    try {
      await reconcileCronJobQueue(candidate.id);
    } catch (error) {
      failed += 1;
      logCronJobQueueSyncFailure(candidate.id)(error);
    }
  }
  return { pending: pending.length, failed };
}

const CRON_JOB_DRIFT_LEASE_KEY = "cohub:cron-jobs:drift-scan:lease";
const CRON_JOB_DRIFT_CURSOR_KEY = "cohub:cron-jobs:drift-scan:cursor";
const CRON_JOB_DRIFT_LEASE_MS = 4 * 60_000;

export async function reconcileCronJobQueueDrift(limit = 100) {
  const acquired = await redisCommandClient.set(
    CRON_JOB_DRIFT_LEASE_KEY,
    `${process.pid}:${Date.now()}`,
    "PX",
    CRON_JOB_DRIFT_LEASE_MS,
    "NX",
  );
  if (acquired !== "OK") return { checked: 0, drifted: 0, failed: 0, skipped: true };

  const cursor = await redisCommandClient.get(CRON_JOB_DRIFT_CURSOR_KEY);
  const conditions = [
    isNull(cronJobs.deletedAt),
    eq(cronJobs.queueSyncedVersion, cronJobs.scheduleVersion),
  ];
  if (cursor) conditions.push(gt(cronJobs.id, cursor));
  const candidates = await db
    .select()
    .from(cronJobs)
    .where(and(...conditions))
    .orderBy(cronJobs.id)
    .limit(limit);

  const queueIndex = indexCronJobQueueEntries(
    candidates.length > 0
      ? await taskQueue.getRepeatableJobs(0, -1, true)
      : [],
  );
  const drifted = candidates.filter(
    (job) => !isCronJobQueueStateCurrent(job, queueIndex),
  );
  let failed = 0;
  for (const candidate of drifted) {
    try {
      await reconcileCronJobQueue(candidate.id, {
        verifyQueueState: true,
        queueIndex,
      });
    } catch (error) {
      failed += 1;
      logCronJobQueueSyncFailure(candidate.id)(error);
    }
  }

  const lastCandidate = candidates.at(-1);
  if (lastCandidate && candidates.length === limit) {
    await redisCommandClient.set(CRON_JOB_DRIFT_CURSOR_KEY, lastCandidate.id);
  } else {
    await redisCommandClient.del(CRON_JOB_DRIFT_CURSOR_KEY);
  }
  return {
    checked: candidates.length,
    drifted: drifted.length,
    failed,
    skipped: false,
  };
}

export function startCronJobQueueReconciler(
  intervalMs = 30_000,
  driftIntervalMs = 5 * 60_000,
) {
  let pendingRunning = false;
  let driftRunning = false;
  const runPending = async () => {
    if (pendingRunning) return;
    pendingRunning = true;
    try {
      await reconcilePendingCronJobQueues();
    } catch (error) {
      logger.error("[CronJob] failed to scan pending queue syncs", { error });
    } finally {
      pendingRunning = false;
    }
  };
  const runDrift = async () => {
    if (driftRunning) return;
    driftRunning = true;
    try {
      await reconcileCronJobQueueDrift();
    } catch (error) {
      logger.error("[CronJob] failed to scan queue drift", { error });
    } finally {
      driftRunning = false;
    }
  };
  void runPending();
  void runDrift();
  const pendingInterval = setInterval(
    () => void runPending(),
    Math.max(1_000, intervalMs),
  );
  const driftInterval = setInterval(
    () => void runDrift(),
    Math.max(1_000, driftIntervalMs),
  );
  pendingInterval.unref();
  driftInterval.unref();
  return () => {
    clearInterval(pendingInterval);
    clearInterval(driftInterval);
  };
}
