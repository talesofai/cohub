import { COHUB_TASKS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { enqueueTaskRun } from "@cohub/core/tasks";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { cronJobs } from "@cohub/db";
import type { TaskPayload, TaskScheduleConfig } from "@cohub/protocol/task";
import { GENERATION_TASK_TYPE } from "@cohub/protocol/generation";
import { dispatchTaskCreated } from "./realtime-events.js";
import { createLogger } from "@cohub/infra/logging";
import {
  CronJobUpdateConflictError,
  nextCronJobUpdateVersion,
} from "./cron-job-concurrency.js";


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

export const removeCronJob = async (cronJobId: string, bullJobKey: string) => {
  if (bullJobKey) {
    await taskQueue.removeRepeatableByKey(bullJobKey);
  }
  await db
    .update(cronJobs)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(cronJobs.id, cronJobId));
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

type CronJobUpdatePatch = {
  title?: string;
  payload?: Record<string, unknown>;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export const updateCronJob = async (
  current: CronJobRow,
  patch: CronJobUpdatePatch,
) => {
  const next = {
    ...current,
    ...patch,
  };
  const changesReschedule =
    patch.payload !== undefined ||
    patch.cronExpression !== undefined ||
    patch.timezone !== undefined;

  const needsSchedule = next.enabled && (
    changesReschedule
    || (patch.enabled === true && !current.enabled)
  );

  if (needsSchedule) {
    const [updatedConfig] = await db
      .update(cronJobs)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        enabled: true,
        updatedAt: nextCronJobUpdateVersion(current.updatedAt),
      })
      .where(cronJobUpdateCondition(current.id, current.updatedAt))
      .returning();
    if (!updatedConfig) throw new CronJobUpdateConflictError();

    let nextBullJobKey: string | null = null;
    try {
      nextBullJobKey = await scheduleCronJobRepeat(
        current.id,
        current.bullJobKey,
        cronJobScheduleData(updatedConfig),
      );
      const [updatedJob] = await db
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
    } catch (error) {
      if (nextBullJobKey) {
        await taskQueue.removeRepeatableByKey(nextBullJobKey).catch((cleanupError) => {
          logger.warn("[CronJob] failed to remove partially scheduled repeat job", { cronJobId: current.id, error: cleanupError });
        });
      }
      const [rolledBack] = await db
        .update(cronJobs)
        .set({
          title: current.title,
          payload: current.payload,
          cronExpression: current.cronExpression,
          timezone: current.timezone,
          bullJobKey: current.bullJobKey,
          enabled: current.enabled,
          updatedAt: nextCronJobUpdateVersion(updatedConfig.updatedAt),
        })
        .where(cronJobUpdateCondition(current.id, updatedConfig.updatedAt))
        .returning();
      if (!rolledBack) logger.warn("[CronJob] failed to roll back cron job after reschedule failure", { cronJobId: current.id });
      if (rolledBack && current.enabled) {
        try {
          const restoredBullJobKey = await scheduleCronJobRepeat(current.id, "", cronJobScheduleData(current));
          const [restoredJob] = await db
            .update(cronJobs)
            .set({
              bullJobKey: restoredBullJobKey,
              enabled: true,
              updatedAt: nextCronJobUpdateVersion(rolledBack.updatedAt),
            })
            .where(cronJobUpdateCondition(current.id, rolledBack.updatedAt))
            .returning();
          if (!restoredJob) {
            await taskQueue.removeRepeatableByKey(restoredBullJobKey);
          }
        } catch (restoreError) {
          logger.warn("[CronJob] failed to restore previous repeat job after reschedule failure", { cronJobId: current.id, error: restoreError });
        }
      }
      throw error;
    }
  }

  if (patch.enabled === false && current.enabled) {
    const [disabledJob] = await db
      .update(cronJobs)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        enabled: false,
        updatedAt: nextCronJobUpdateVersion(current.updatedAt),
      })
      .where(cronJobUpdateCondition(current.id, current.updatedAt))
      .returning();
    if (!disabledJob) throw new CronJobUpdateConflictError();

    try {
      if (current.bullJobKey) {
        await taskQueue.removeRepeatableByKey(current.bullJobKey);
      }
      return disabledJob;
    } catch (error) {
      await db
        .update(cronJobs)
        .set({
          title: current.title,
          payload: current.payload,
          cronExpression: current.cronExpression,
          timezone: current.timezone,
          bullJobKey: current.bullJobKey,
          enabled: current.enabled,
          updatedAt: nextCronJobUpdateVersion(disabledJob.updatedAt),
        })
        .where(cronJobUpdateCondition(current.id, disabledJob.updatedAt))
        .catch((rollbackError) => {
          logger.warn("[CronJob] failed to roll back cron job after disable failure", {
            cronJobId: current.id,
            error: rollbackError,
          });
        });
      throw error;
    }
  }

  const [updatedJob] = await db
    .update(cronJobs)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: nextCronJobUpdateVersion(current.updatedAt),
    })
    .where(cronJobUpdateCondition(current.id, current.updatedAt))
    .returning();
  if (!updatedJob) throw new CronJobUpdateConflictError();
  return updatedJob;
};
