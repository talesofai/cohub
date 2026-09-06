import { createHash } from "node:crypto";
import type { LockDbLease } from "@cohub/infra/lock-db-pool";
import { lockDbPool } from "./db.js";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-worker" });

const advisoryKeys = (spaceId: string): [number, number] => {
  const digest = createHash("sha256").update(`cohub-workspace-writer-v1\0${spaceId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
};

export type WorkspacePhysicalLock = { release: () => Promise<void> };

export async function acquireWorkspacePhysicalLock(spaceId: string): Promise<WorkspacePhysicalLock | null> {
  const [key1, key2] = advisoryKeys(spaceId);
  const lock: LockDbLease = await lockDbPool.acquire();
  try {
    const rows = await lock.connection.unsafe<Array<{ locked: boolean }>>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [key1, key2],
    );
    if (rows[0]?.locked !== true) {
      await lock.release();
      return null;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const unlockRows = await lock.connection.unsafe<Array<{ unlocked: boolean }>>(
            "select pg_advisory_unlock($1, $2) as unlocked",
            [key1, key2],
          );
          if (unlockRows[0]?.unlocked !== true) throw new Error("workspace_advisory_unlock_failed");
          await lock.release();
        } catch (error) {
          logger.error("failed to release workspace advisory lock; retiring the lock connection", { spaceId, error });
          await lock.discard();
          throw error;
        }
      },
    };
  } catch (error) {
    await lock.discard();
    throw error;
  }
}
