import assert from "node:assert/strict";
import { test } from "node:test";
import { LockDbPool, type LockDbClient, type LockDbConnection } from "./lock-db-pool.js";

type PoolState = {
  created: number;
  ended: number;
  releases: number;
  reserveFailures: number;
  releaseFailures: number;
  events: string[];
};

function fakeClientFactory(state: PoolState) {
  return (): LockDbClient => {
    const clientId = ++state.created;
    return {
      reserve: async (): Promise<LockDbConnection> => {
        if (state.reserveFailures > 0) {
          state.reserveFailures -= 1;
          throw new Error("reserve failed");
        }
        return {
          release: () => {
            state.releases += 1;
            state.events.push(`release:${clientId}`);
            if (state.releaseFailures > 0) {
              state.releaseFailures -= 1;
              throw new Error("release failed");
            }
          },
          unsafe: async <T extends unknown[]>(query: string) =>
            (query.includes("unlock") ? [{ unlocked: true }] : [{ locked: true }]) as T,
        };
      },
      end: async () => {
        state.ended += 1;
        state.events.push(`end:${clientId}`);
      },
    };
  };
}

const newState = (): PoolState => ({
  created: 0,
  ended: 0,
  releases: 0,
  reserveFailures: 0,
  releaseFailures: 0,
  events: [],
});

test("bounds lock connections and reuses released slots", async () => {
  const state = newState();
  const pool = new LockDbPool(fakeClientFactory(state), 1);
  const first = await pool.acquire();
  let secondAcquired = false;
  const secondPromise = pool.acquire().then((lease) => {
    secondAcquired = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);
  await first.release();
  const second = await secondPromise;
  assert.equal(state.created, 1);
  assert.equal(state.releases, 1);
  await second.release();
  await pool.close();
  assert.equal(state.releases, 2);
  assert.equal(state.ended, 1);
});

test("retires a discarded client after releasing its reserved handle", async () => {
  const state = newState();
  const pool = new LockDbPool(fakeClientFactory(state), 1);
  const first = await pool.acquire();
  await first.discard();
  assert.deepEqual(state.events, ["release:1", "end:1"]);

  const second = await pool.acquire();
  assert.equal(state.created, 2);
  await second.release();
  await pool.close();
  assert.equal(state.ended, 2);
  assert.equal(state.releases, 2);
});

test("rejects waiters and retires busy clients when they return after close", async () => {
  const state = newState();
  const pool = new LockDbPool(fakeClientFactory(state), 1);
  const first = await pool.acquire();
  const waiting = pool.acquire();
  await pool.close();
  await assert.rejects(waiting, /lock database pool is closed/);
  assert.equal(state.ended, 0);

  await first.release();
  assert.deepEqual(state.events, ["release:1", "end:1"]);
});

test("retires a client whose reserve fails and allows a later acquisition", async () => {
  const state = newState();
  state.reserveFailures = 1;
  const pool = new LockDbPool(fakeClientFactory(state), 1);
  await assert.rejects(pool.acquire(), /reserve failed/);
  assert.deepEqual(state.events, ["end:1"]);

  const lease = await pool.acquire();
  assert.equal(state.created, 2);
  await lease.release();
  await pool.close();
});

test("retires a client when releasing its reserved handle fails", async () => {
  const state = newState();
  state.releaseFailures = 1;
  const pool = new LockDbPool(fakeClientFactory(state), 1);
  const first = await pool.acquire();
  await assert.rejects(first.release(), /release failed/);
  assert.deepEqual(state.events, ["release:1", "end:1"]);

  const replacement = await pool.acquire();
  assert.equal(state.created, 2);
  await replacement.release();
  await pool.close();
});

test("close retires a connection that finishes reserving after shutdown starts", async () => {
  const state = newState();
  let resolveReserve: (connection: LockDbConnection) => void = () => {
    throw new Error("reserve resolver was not initialized");
  };
  const pool = new LockDbPool(() => {
    const clientId = ++state.created;
    return {
      reserve: () => new Promise<LockDbConnection>((resolve) => {
        resolveReserve = resolve;
      }),
      end: async () => {
        state.ended += 1;
        state.events.push(`end:${clientId}`);
      },
    };
  }, 1);
  const acquiring = pool.acquire();
  await Promise.resolve();
  await pool.close();
  resolveReserve({
    release: () => {
      state.releases += 1;
      state.events.push("release:1");
    },
    unsafe: async <T extends unknown[]>() => [] as unknown as T,
  });
  await assert.rejects(acquiring, /lock database pool is closed/);
  assert.deepEqual(state.events, ["release:1", "end:1"]);
});
