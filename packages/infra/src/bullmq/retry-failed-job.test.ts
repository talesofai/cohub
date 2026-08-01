import assert from "node:assert/strict";
import test from "node:test";
import { retryFailedQueueJob } from "./index.js";

test("retryFailedQueueJob retries only failed jobs", async () => {
  let retryCalls = 0;
  const job = {
    getState: async () => "failed",
    retry: async () => {
      retryCalls += 1;
    },
  };

  const recovered = await retryFailedQueueJob({ getJob: async () => job }, "task-1");

  assert.equal(recovered, job);
  assert.equal(retryCalls, 1);
  assert.equal(
    await retryFailedQueueJob({
      getJob: async () => ({ ...job, getState: async () => "completed" }),
    }, "task-1"),
    null,
  );
});

test("retryFailedQueueJob accepts a concurrent retry that already moved the job", async () => {
  let state = "failed";
  const job = {
    getState: async () => state,
    retry: async () => {
      state = "waiting";
      throw new Error("Job is not in the failed state");
    },
  };

  const recovered = await retryFailedQueueJob({ getJob: async () => job }, "task-1");

  assert.equal(recovered, job);
});
