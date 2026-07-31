import assert from "node:assert/strict";
import test from "node:test";
import type { TaskPayload } from "@cohub/protocol/task";
import { enqueueTaskRun, TaskIdempotencyConflictError } from "./enqueue.js";

type StoredTaskRun = {
  id: string;
  jobId: string;
  status: string;
  startedAt: Date | null;
  errorMessage: string | null;
  finishedAt: Date | null;
  [key: string]: unknown;
};

function createTaskDb() {
  let stored: StoredTaskRun | null = null;

  const applyUpdate = (values: Record<string, unknown>) => {
    if (stored) Object.assign(stored, values);
    return stored;
  };

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (stored?.jobId === values.jobId) return [];
            stored = {
              ...values,
              id: String(values.id),
              jobId: String(values.jobId),
              status: String(values.status),
              startedAt: null,
              errorMessage: null,
              finishedAt: null,
            };
            return [stored];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => stored ? [stored] : [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const execute = Promise.resolve().then(() => {
            applyUpdate(values);
          });
          return Object.assign(execute, {
            returning: async () => {
              const updated = applyUpdate(values);
              return updated ? [updated] : [];
            },
          });
        },
      }),
    }),
  };

  return {
    db: db as never,
    getStored: () => stored,
    markCompleted: () => {
      if (!stored) throw new Error("task run not created");
      stored.status = "completed";
      stored.startedAt = new Date();
    },
  };
}

const payload: TaskPayload = {
  type: "space_hook",
  spaceId: "00000000-0000-4000-8000-000000000001",
};

test("enqueueTaskRun keeps task UUID separate from a custom queue job id", async () => {
  const taskDb = createTaskDb();
  let queueJobId: string | undefined;

  const result = await enqueueTaskRun({
    db: taskDb.db,
    payload,
    options: { jobId: "space-hook-event-1" },
    enqueue: async (_name, _payload, options) => {
      queueJobId = options.jobId;
      return { id: options.jobId };
    },
  });

  assert.match(result.taskRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(queueJobId, "space-hook-event-1");
  assert.equal(taskDb.getStored()?.id, result.taskRunId);
  assert.equal(taskDb.getStored()?.jobId, "space-hook-event-1");
});

test("enqueueTaskRun recovers a task that failed before queueing and deduplicates completed work", async () => {
  const taskDb = createTaskDb();
  let enqueueAttempts = 0;
  const enqueue = async () => {
    enqueueAttempts += 1;
    if (enqueueAttempts === 1) throw new Error("queue unavailable");
    return { id: "space-hook-event-2" };
  };
  const input = {
    db: taskDb.db,
    payload,
    options: { jobId: "space-hook-event-2" },
    enqueue,
  };

  await assert.rejects(enqueueTaskRun(input), /queue unavailable/);
  const failedTaskRunId = taskDb.getStored()?.id;
  assert.equal(taskDb.getStored()?.status, "failed");
  assert.equal(taskDb.getStored()?.startedAt, null);

  const recovered = await enqueueTaskRun(input);
  assert.equal(recovered.taskRunId, failedTaskRunId);
  assert.equal(taskDb.getStored()?.status, "pending");
  assert.equal(taskDb.getStored()?.errorMessage, null);
  assert.equal(taskDb.getStored()?.finishedAt, null);
  assert.equal(enqueueAttempts, 2);

  taskDb.markCompleted();
  const duplicate = await enqueueTaskRun(input);
  assert.equal(duplicate.taskRunId, failedTaskRunId);
  assert.equal(duplicate.job, null);
  assert.equal(enqueueAttempts, 2);
});

test("stable task ids reject a different request fingerprint before queueing", async () => {
  const taskDb = createTaskDb();
  let enqueueAttempts = 0;
  const enqueue = async () => {
    enqueueAttempts += 1;
    return { id: "generation-request-1" };
  };
  await enqueueTaskRun({
    db: taskDb.db,
    payload: { ...payload, data: { model: "model-a" } },
    options: { jobId: "generation-request-1", idempotencyFingerprint: "fingerprint-a" },
    enqueue,
  });

  await assert.rejects(
    enqueueTaskRun({
      db: taskDb.db,
      payload: { ...payload, data: { model: "model-b" } },
      options: { jobId: "generation-request-1", idempotencyFingerprint: "fingerprint-b" },
      enqueue,
    }),
    TaskIdempotencyConflictError,
  );
  assert.equal(enqueueAttempts, 1);
});

test("stable task retries enqueue only the payload that won the database insert", async () => {
  const taskDb = createTaskDb();
  const queuedPayloads: TaskPayload[] = [];
  const enqueue = async (_name: string, queuedPayload: TaskPayload) => {
    queuedPayloads.push(queuedPayload);
    return { id: "generation-request-2" };
  };
  const winner = { ...payload, data: { model: "model-a" } };
  await enqueueTaskRun({
    db: taskDb.db,
    payload: winner,
    options: { jobId: "generation-request-2", idempotencyFingerprint: "fingerprint-a" },
    enqueue,
  });
  await enqueueTaskRun({
    db: taskDb.db,
    payload: { ...payload, data: { model: "model-b" } },
    options: { jobId: "generation-request-2", idempotencyFingerprint: "fingerprint-a" },
    enqueue,
  });

  assert.deepEqual(queuedPayloads, [winner, winner]);
});
