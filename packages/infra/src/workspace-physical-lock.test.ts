import assert from "node:assert/strict";
import { test } from "node:test";
import type { LockDbLease } from "./lock-db-pool.js";
import { createWorkspacePhysicalLockManager } from "./workspace-physical-lock.js";

type HarnessOptions = {
  locked?: unknown;
  beginError?: Error;
  acquireError?: Error;
  commitError?: Error;
  rollbackError?: Error;
  releaseError?: Error;
};

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const queries: Array<{ query: string; parameters?: unknown[] }> = [];
  const lock: LockDbLease = {
    connection: {
      release: () => undefined,
      unsafe: async <T extends unknown[]>(query: string, parameters?: unknown[]) => {
        queries.push({ query, parameters });
        if (query === "begin") {
          events.push("begin");
          if (options.beginError) throw options.beginError;
          return [] as unknown as T;
        }
        if (query.includes("pg_try_advisory_xact_lock")) {
          events.push("try");
          if (options.acquireError) throw options.acquireError;
          const locked = "locked" in options ? options.locked : true;
          return [{ locked }] as unknown as T;
        }
        if (query === "commit") {
          events.push("commit");
          if (options.commitError) throw options.commitError;
          return [] as unknown as T;
        }
        if (query === "rollback") {
          events.push("rollback");
          if (options.rollbackError) throw options.rollbackError;
          return [] as unknown as T;
        }
        throw new Error(`unexpected query: ${query}`);
      },
    },
    release: async () => {
      events.push("release");
      if (options.releaseError) throw options.releaseError;
    },
    discard: async () => {
      events.push("discard");
    },
  };
  const reported: Array<{ spaceId: string; error: unknown }> = [];
  const manager = createWorkspacePhysicalLockManager({
    pool: {
      acquire: async () => {
        events.push("acquire");
        return lock;
      },
    },
    onReleaseError: (spaceId, error) => reported.push({ spaceId, error }),
  });
  return { events, manager, queries, reported };
}

test("acquires and idempotently commits the workspace advisory lock transaction", async () => {
  const harness = createHarness();
  const lock = await harness.manager.acquire("space-1");
  assert.ok(lock);

  const firstRelease = lock.release();
  const secondRelease = lock.release();
  assert.equal(firstRelease, secondRelease);
  await firstRelease;

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "commit", "release"]);
  assert.deepEqual(harness.queries.map(({ query, parameters }) => ({ query, parameters })), [
    { query: "begin", parameters: undefined },
    { query: "select pg_try_advisory_xact_lock($1, $2) as locked", parameters: [-1022639053, 381768453] },
    { query: "commit", parameters: undefined },
  ]);
  assert.deepEqual(harness.reported, []);
});

test("rolls back and returns null when the workspace lock is active", async () => {
  const harness = createHarness({ locked: false });
  assert.equal(await harness.manager.acquire("space-1"), null);
  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "release"]);
});

test("discards a lease when beginning the lock transaction fails", async () => {
  const beginError = new Error("begin failed");
  const harness = createHarness({ beginError });
  await assert.rejects(harness.manager.acquire("space-1"), beginError);
  assert.deepEqual(harness.events, ["acquire", "begin", "discard"]);
});

test("rolls back when advisory lock acquisition fails", async () => {
  const acquireError = new Error("acquisition failed");
  const harness = createHarness({ acquireError });
  await assert.rejects(harness.manager.acquire("space-1"), acquireError);
  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "release"]);
});

test("rolls back when the advisory lock result is invalid", async () => {
  const harness = createHarness({ locked: null });
  await assert.rejects(harness.manager.acquire("space-1"), /workspace_advisory_lock_result_invalid/);
  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "release"]);
});

test("reports commit failure and discards the connection", async () => {
  const harness = createHarness({ commitError: new Error("commit failed") });
  const lock = await harness.manager.acquire("space-1");
  assert.ok(lock);

  const firstRelease = lock.release();
  const secondRelease = lock.release();
  assert.equal(firstRelease, secondRelease);
  await assert.rejects(firstRelease, /commit failed/);

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "commit", "discard"]);
  assert.equal(harness.reported.length, 1);
  assert.equal(harness.reported[0]?.spaceId, "space-1");
});

test("reports lease release failure after committing and retires the connection", async () => {
  const releaseError = new Error("release failed");
  const harness = createHarness({ releaseError });
  const lock = await harness.manager.acquire("space-1");
  assert.ok(lock);

  await assert.rejects(lock.release(), releaseError);

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "commit", "release", "discard"]);
  assert.deepEqual(harness.reported, [{ spaceId: "space-1", error: releaseError }]);
});

test("runs an operation while holding the lock", async () => {
  const harness = createHarness();
  const result = await harness.manager.withLock("space-1", async () => {
    harness.events.push("operation");
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(harness.events, ["acquire", "begin", "try", "operation", "commit", "release"]);
});

test("preserves the operation error when commit also fails", async () => {
  const operationError = new Error("operation failed");
  const harness = createHarness({ commitError: new Error("commit failed") });

  await assert.rejects(
    harness.manager.withLock("space-1", async () => {
      throw operationError;
    }),
    operationError,
  );

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "commit", "discard"]);
  assert.equal(harness.reported.length, 1);
});

test("acquire surfaces failure rolling back a contended transaction", async () => {
  const rollbackError = new Error("rollback failed");
  const harness = createHarness({ locked: false, rollbackError });

  await assert.rejects(harness.manager.acquire("space-1"), rollbackError);

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "discard"]);
  assert.deepEqual(harness.reported, []);
});

test("withLock preserves contention error when rolling back the transaction fails", async () => {
  const rollbackError = new Error("rollback failed");
  const harness = createHarness({ locked: false, rollbackError });

  await assert.rejects(harness.manager.withLock("space-1", async () => undefined), /workspace_physical_writer_active/);

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "discard"]);
  assert.deepEqual(harness.reported, [{ spaceId: "space-1", error: rollbackError }]);
});

test("reports both acquisition and rollback failures", async () => {
  const acquireError = new Error("acquisition failed");
  const rollbackError = new Error("rollback failed");
  const harness = createHarness({ acquireError, rollbackError });

  await assert.rejects(
    harness.manager.acquire("space-1"),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === acquireError && error.errors[1] === rollbackError,
  );

  assert.deepEqual(harness.events, ["acquire", "begin", "try", "rollback", "discard"]);
});
