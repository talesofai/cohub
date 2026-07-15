import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@cohub/db";
import { taskRuns } from "@cohub/db";
import type { TaskPayload } from "@cohub/protocol/task";

export type TaskQueueJobOptions = { [key: string]: unknown; jobId?: string; delay?: number };
export type TaskEnqueueOptions = Omit<TaskQueueJobOptions, "scheduledAt" | "taskRunId"> & {
  scheduledAt?: Date | null;
  taskRunId?: string;
};

type TasksDb = PostgresJsDatabase<typeof schema>;

export type EnqueueTaskRunInput<Job = unknown> = {
  db: TasksDb;
  payload: TaskPayload;
  options?: TaskEnqueueOptions;
  enqueue: (name: string, payload: TaskPayload, options: TaskQueueJobOptions) => Promise<Job>;
  onTaskCreated?: (taskRun: typeof taskRuns.$inferSelect) => Promise<void> | void;
};

export async function enqueueTaskRun<Job = unknown>(input: EnqueueTaskRunInput<Job>) {
  const taskRunId = input.options?.taskRunId ?? crypto.randomUUID();
  const { scheduledAt, taskRunId: _requestedTaskRunId, ...jobOptions } = input.options ?? {};
  const delay = typeof jobOptions.delay === "number" ? jobOptions.delay : 0;
  const scheduledAtValue = scheduledAt ?? (delay > 0 ? new Date(Date.now() + delay) : null);

  const [taskRun] = await input.db.insert(taskRuns).values({
    id: taskRunId,
    jobId: taskRunId,
    taskType: input.payload.type,
    spaceId: input.payload.spaceId ?? null,
    sessionId: input.payload.sessionId ?? null,
    turnId: input.payload.turnId ?? null,
    userUuid: input.payload.userId ?? null,
    cronJobId: input.payload.cronJobId ?? null,
    status: "pending",
    payload: input.payload,
    scheduledAt: scheduledAtValue,
  }).onConflictDoNothing({ target: taskRuns.id }).returning();

  try {
    const job = await input.enqueue(input.payload.type, input.payload, {
      ...jobOptions,
      jobId: taskRunId,
    });

    if (taskRun) await input.onTaskCreated?.(taskRun);
    return { job, taskRunId };
  } catch (error) {
    await input.db.update(taskRuns).set({
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(taskRuns.id, taskRunId)).catch(() => undefined);
    throw error;
  }
}
