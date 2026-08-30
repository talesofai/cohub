import { createHash } from "node:crypto";
import type { LockDbLease } from "@cohub/infra/lock-db-pool";
import { lockDbPool } from "./db/index.js";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-api" });

const advisoryKeys = (spaceId: string): [number, number] => {
  const digest = createHash("sha256").update(`cohub-workspace-writer-v1\0${spaceId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
};

export async function withWorkspacePhysicalLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const [key1, key2] = advisoryKeys(spaceId);
  const lock: LockDbLease = await lockDbPool.acquire();
  let lockState: "unknown" | "not_acquired" | "acquired" = "unknown";
  let result: T | undefined;
  let operationError: unknown = null;
  let releaseError: unknown = null;
  try {
    const rows = await lock.connection.unsafe<Array<{ locked: boolean }>>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [key1, key2],
    );
    if (rows[0]?.locked !== true) {
      lockState = "not_acquired";
      operationError = new Error("workspace_physical_writer_active");
    } else {
      lockState = "acquired";
      result = await fn();
    }
  } catch (error) {
    operationError = error;
  }
  if (lockState === "not_acquired") {
    await lock.release().catch((error) => {
      releaseError = error;
    });
  } else if (lockState === "acquired") {
    try {
      const rows = await lock.connection.unsafe<Array<{ unlocked: boolean }>>(
        "select pg_advisory_unlock($1, $2) as unlocked",
        [key1, key2],
      );
      if (rows[0]?.unlocked !== true) throw new Error("workspace_advisory_unlock_failed");
      await lock.release();
    } catch (error) {
      releaseError = error;
      await lock.discard();
    }
  } else {
    // The lock result was never known; terminate the slot's client rather
    // than returning a session that may already own the advisory lock.
    await lock.discard();
  }
  if (releaseError) {
    logger.error("failed to release workspace advisory lock", { spaceId, error: releaseError });
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result as T;
}
