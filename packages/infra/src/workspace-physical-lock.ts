import { createHash } from "node:crypto";
import type { LockDbLease } from "./lock-db-pool.js";

export type WorkspacePhysicalLock = {
  release: () => Promise<void>;
};

type WorkspacePhysicalLockPool = {
  acquire: () => Promise<LockDbLease>;
};

type WorkspacePhysicalLockManager = {
  acquire: (spaceId: string) => Promise<WorkspacePhysicalLock | null>;
  withLock: <T>(spaceId: string, operation: () => Promise<T>) => Promise<T>;
};

type WorkspacePhysicalLockManagerOptions = {
  pool: WorkspacePhysicalLockPool;
  onReleaseError?: (spaceId: string, error: unknown) => void;
};

type WorkspacePhysicalLockAcquisition =
  | { status: "acquired"; lock: WorkspacePhysicalLock }
  | { status: "contended" }
  | { status: "contended_release_failed"; error: unknown };

const advisoryKeys = (spaceId: string): [number, number] => {
  const digest = createHash("sha256").update(`cohub-workspace-writer-v1\0${spaceId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
};

const tryAcquire = async (lock: LockDbLease, keys: [number, number]): Promise<boolean> => {
  const rows = await lock.connection.unsafe<Array<{ locked: boolean }>>(
    "select pg_try_advisory_xact_lock($1, $2) as locked",
    keys,
  );
  const locked = rows[0]?.locked;
  if (locked !== true && locked !== false) throw new Error("workspace_advisory_lock_result_invalid");
  return locked;
};

const finishTransaction = async (lock: LockDbLease, statement: "commit" | "rollback"): Promise<void> => {
  try {
    await lock.connection.unsafe(statement);
    await lock.release();
  } catch (error) {
    await lock.discard();
    throw error;
  }
};

const rollbackAfterAcquisitionError = async (lock: LockDbLease, acquisitionError: unknown): Promise<never> => {
  try {
    await finishTransaction(lock, "rollback");
  } catch (rollbackError) {
    throw new AggregateError(
      [acquisitionError, rollbackError],
      "workspace advisory lock acquisition and rollback both failed",
    );
  }
  throw acquisitionError;
};

/** Holds transaction-scoped locks on reserved connections, including through transaction-pooling proxies. */
export function createWorkspacePhysicalLockManager(
  options: WorkspacePhysicalLockManagerOptions,
): WorkspacePhysicalLockManager {
  const acquiredLock = (spaceId: string, lock: LockDbLease): WorkspacePhysicalLock => {
    let releasePromise: Promise<void> | null = null;
    return {
      release: () => {
        releasePromise ??= (async () => {
          try {
            await finishTransaction(lock, "commit");
          } catch (error) {
            options.onReleaseError?.(spaceId, error);
            throw error;
          }
        })();
        return releasePromise;
      },
    };
  };

  const acquireInternal = async (spaceId: string): Promise<WorkspacePhysicalLockAcquisition> => {
    const keys = advisoryKeys(spaceId);
    const lock = await options.pool.acquire();
    try {
      await lock.connection.unsafe("begin");
    } catch (error) {
      await lock.discard();
      throw error;
    }

    let acquired: boolean;
    try {
      acquired = await tryAcquire(lock, keys);
    } catch (error) {
      return rollbackAfterAcquisitionError(lock, error);
    }
    if (acquired) return { status: "acquired", lock: acquiredLock(spaceId, lock) };
    try {
      await finishTransaction(lock, "rollback");
      return { status: "contended" };
    } catch (error) {
      return { status: "contended_release_failed", error };
    }
  };

  const acquire = async (spaceId: string): Promise<WorkspacePhysicalLock | null> => {
    const acquisition = await acquireInternal(spaceId);
    if (acquisition.status === "acquired") return acquisition.lock;
    if (acquisition.status === "contended_release_failed") throw acquisition.error;
    return null;
  };

  const withLock = async <T>(spaceId: string, operation: () => Promise<T>): Promise<T> => {
    const acquisition = await acquireInternal(spaceId);
    if (acquisition.status !== "acquired") {
      if (acquisition.status === "contended_release_failed") {
        options.onReleaseError?.(spaceId, acquisition.error);
      }
      throw new Error("workspace_physical_writer_active");
    }

    let result: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let releaseFailed = false;
    let releaseError: unknown;
    try {
      await acquisition.lock.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }

    if (operationFailed) throw operationError;
    if (releaseFailed) throw releaseError;
    return result as T;
  };

  return { acquire, withLock };
}
