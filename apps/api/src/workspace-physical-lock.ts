import { createLogger } from "@cohub/infra/logging";
import { createWorkspacePhysicalLockManager } from "@cohub/infra/workspace-physical-lock";
import { lockDbPool } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });
const workspacePhysicalLocks = createWorkspacePhysicalLockManager({
  pool: lockDbPool,
  onReleaseError: (spaceId, error) => {
    logger.error("failed to finish workspace lock transaction", { spaceId, error });
  },
});

export async function withWorkspacePhysicalLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  return workspacePhysicalLocks.withLock(spaceId, fn);
}
