import { COHUB_TASKS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { enqueueTaskRun } from "@cohub/core/tasks";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { cronJobs } from "@cohub/db";
import type { TaskPayload, TaskScheduleConfig } from "@cohub/protocol/task";
import { GENERATION_TASK_TYPE } from "@cohub/protocol/generation";
import { dispatchTaskCreated } from "./realtime-events.js";
import { createLogger } from "@cohub/infra/logging";
import {
  assertCronJobUpdateVersion,
  CronJobUpdateConflictError,
  nextCronJobUpdateVersion,
} from "./cron-job-concurrency.js";
import { runCronJobQueueTransaction } from "./cron-job-queue-transaction.js";


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
  const taskPayload: TaskPayload = {
    type: params.taskType,
    spaceId: params.spaceId ?? undefined,
    sessionId: params.sessionId ?? undefined,
    userId: params.userId,
    data: params.payload,
  };

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

  try {
    const job = await taskQueue.add(
      params.taskType,
      { ...taskPayload, cronJobId: cronJob.id },
      {
        repeat: {
          pattern: params.schedule.pattern,
          tz: params.schedule.timezone ?? "Asia/Shanghai",
        },
        jobId: `cron-${cronJob.id}`,
        ...defaultJobRetention,
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
      },
    );

    const repeatJobKey = job.repeatJobKey;
    if (!repeatJobKey) throw new Error("Failed to get repeat job key");

    await db
      .update(cronJobs)
      .set({ bullJobKey: repeatJobKey })
      .where(eq(cronJobs.id, cronJob.id));

    const [createdJob] = await db
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.id, cronJob.id))
      .limit(1);
    if (!createdJob) throw new Error("Failed to load cron job record after scheduling");

    return createdJob;
  } catch (queueError) {
    await db
      .update(cronJobs)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(cronJobs.id, cronJob.id));

    throw new Error(
      `Cron job record created but failed to schedule in queue: ${queueError instanceof Error ? queueError.message : String(queueError)}`,
    );
  }
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
};

async function scheduleCronJobRepeat(
  cronJobId: string,
  bullJobKey: string,
  jobData: CronJobScheduleData,
) {
  if (bullJobKey) {
    await taskQueue.removeRepeatableByKey(bullJobKey);
  }

  const taskPayload: TaskPayload = {
    type: jobData.taskType,
    spaceId: jobData.spaceId ?? undefined,
    sessionId: jobData.sessionId ?? undefined,
    userId: jobData.userUuid,
    data: jobData.payload,
    cronJobId,
  };

  const job = await taskQueue.add(
    jobData.taskType,
    taskPayload,
    {
      repeat: { pattern: jobData.cronExpression, tz: jobData.timezone },
      jobId: `cron-${cronJobId}`,
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
});

type CronJobRow = typeof cronJobs.$inferSelect;

type CronJobQueueRollback = {
  previous: CronJobRow;
  replacementBullJobKey?: string;
};

const sameCronJobVersion = (left: Date | null, right: Date | null) =>
  left?.getTime() === right?.getTime();

async function compensateCronJobQueue(rollback: CronJobQueueRollback) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${rollback.previous.id}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(cronJobs)
      .where(eq(cronJobs.id, rollback.previous.id))
      .limit(1);

    const stillOwnsVersion = Boolean(
      current &&
        !current.deletedAt &&
        sameCronJobVersion(current.updatedAt, rollback.previous.updatedAt),
    );
    if (!stillOwnsVersion) {
      if (
        rollback.replacementBullJobKey &&
        rollback.replacementBullJobKey !== current?.bullJobKey
      ) {
        await taskQueue.removeRepeatableByKey(rollback.replacementBullJobKey);
      }
      return;
    }
    if (!current) return;

    if (rollback.replacementBullJobKey) {
      await taskQueue.removeRepeatableByKey(rollback.replacementBullJobKey);
    }
    if (!current.enabled) return;

    const restoredBullJobKey = await scheduleCronJobRepeat(
      current.id,
      "",
      cronJobScheduleData(current),
    );
    if (restoredBullJobKey === current.bullJobKey) return;

    await tx
      .update(cronJobs)
      .set({
        bullJobKey: restoredBullJobKey,
        updatedAt: nextCronJobUpdateVersion(current.updatedAt),
      })
      .where(cronJobUpdateCondition(current.id, current.updatedAt));
  });
}

const logCronJobCompensationFailure = (cronJobId: string) => (error: unknown) => {
  logger.error("[CronJob] failed to reconcile queue after database rollback", {
    cronJobId,
    error,
  });
};

export const removeCronJob = async (cronJobId: string) =>
  runCronJobQueueTransaction(
    (registerRollback) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${cronJobId}, 0))`,
        );
        const [current] = await tx
          .select()
          .from(cronJobs)
          .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
          .limit(1);
        if (!current) throw new CronJobUpdateConflictError();

        registerRollback({ previous: current });
        if (current.bullJobKey) {
          await taskQueue.removeRepeatableByKey(current.bullJobKey);
        }

        const [deletedJob] = await tx
          .update(cronJobs)
          .set({
            deletedAt: new Date(),
            enabled: false,
            updatedAt: nextCronJobUpdateVersion(current.updatedAt),
          })
          .where(cronJobUpdateCondition(current.id, current.updatedAt))
          .returning();
        if (!deletedJob) throw new CronJobUpdateConflictError();
        return deletedJob;
      }),
    compensateCronJobQueue,
    logCronJobCompensationFailure(cronJobId),
  );

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
) =>
  runCronJobQueueTransaction(
    (registerRollback) =>
      db.transaction(async (tx) => {
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

        const next = { ...current, ...patch };
        const changesReschedule =
          patch.payload !== undefined ||
          patch.cronExpression !== undefined ||
          patch.timezone !== undefined;
        const needsSchedule =
          next.enabled &&
          (changesReschedule || (patch.enabled === true && !current.enabled));

        if (needsSchedule) {
          const [updatedConfig] = await tx
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
              enabled: true,
              updatedAt: nextCronJobUpdateVersion(current.updatedAt),
            })
            .where(cronJobUpdateCondition(current.id, current.updatedAt))
            .returning();
          if (!updatedConfig) throw new CronJobUpdateConflictError();

          const rollback: CronJobQueueRollback = { previous: current };
          registerRollback(rollback);
          const nextBullJobKey = await scheduleCronJobRepeat(
            current.id,
            current.bullJobKey,
            cronJobScheduleData(updatedConfig),
          );
          rollback.replacementBullJobKey = nextBullJobKey;

          const [updatedJob] = await tx
            .update(cronJobs)
            .set({
              bullJobKey: nextBullJobKey,
              enabled: true,
              updatedAt: nextCronJobUpdateVersion(updatedConfig.updatedAt),
            })
            .where(cronJobUpdateCondition(current.id, updatedConfig.updatedAt))
            .returning();
          if (!updatedJob) throw new CronJobUpdateConflictError();
          return updatedJob;
        }

        if (patch.enabled === false && current.enabled) {
          const [disabledJob] = await tx
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
              enabled: false,
              updatedAt: nextCronJobUpdateVersion(current.updatedAt),
            })
            .where(cronJobUpdateCondition(current.id, current.updatedAt))
            .returning();
          if (!disabledJob) throw new CronJobUpdateConflictError();

          registerRollback({ previous: current });
          if (current.bullJobKey) {
            await taskQueue.removeRepeatableByKey(current.bullJobKey);
          }
          return disabledJob;
        }

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
            updatedAt: nextCronJobUpdateVersion(current.updatedAt),
          })
          .where(cronJobUpdateCondition(current.id, current.updatedAt))
          .returning();
        if (!updatedJob) throw new CronJobUpdateConflictError();
        return updatedJob;
      }),
    compensateCronJobQueue,
    logCronJobCompensationFailure(snapshot.id),
  );
