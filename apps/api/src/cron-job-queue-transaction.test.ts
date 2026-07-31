import assert from "node:assert/strict";
import { test } from "node:test";
import { runCronJobQueueTransaction } from "./cron-job-queue-transaction.js";

test("queue state is compensated when the database transaction fails during commit", async () => {
  const events: string[] = [];
  const commitError = new Error("commit failed");

  await assert.rejects(
    runCronJobQueueTransaction<never, { cronJobId: string }>(
      async (registerRollback) => {
        registerRollback({ cronJobId: "cron-1" });
        events.push("queue-mutated");
        throw commitError;
      },
      async (plan) => {
        events.push(`compensated:${plan.cronJobId}`);
      },
      () => events.push("compensation-failed"),
    ),
    (error) => error === commitError,
  );

  assert.deepEqual(events, ["queue-mutated", "compensated:cron-1"]);
});

test("failed transactions without a queue mutation do not compensate", async () => {
  let compensationCount = 0;

  await assert.rejects(
    runCronJobQueueTransaction<never, never>(
      async () => {
        throw new Error("conflict");
      },
      async () => {
        compensationCount += 1;
      },
      () => {},
    ),
    /conflict/,
  );

  assert.equal(compensationCount, 0);
});

test("compensation failures preserve the original transaction error", async () => {
  const commitError = new Error("commit failed");
  const compensationErrors: unknown[] = [];

  await assert.rejects(
    runCronJobQueueTransaction<never, string>(
      async (registerRollback) => {
        registerRollback("restore-old-repeat");
        throw commitError;
      },
      async () => {
        throw new Error("redis unavailable");
      },
      (error) => compensationErrors.push(error),
    ),
    (error) => error === commitError,
  );

  assert.equal(compensationErrors.length, 1);
  assert.match(String(compensationErrors[0]), /redis unavailable/);
});
