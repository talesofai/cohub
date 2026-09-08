import { createLogger } from "@cohub/infra/logging";
import {
  createWorkspacePhysicalLockManager,
  type WorkspacePhysicalLock as InfraWorkspacePhysicalLock,
} from "@cohub/infra/workspace-physical-lock";
import { lockDbPool } from "./db.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const workspacePhysicalLocks = createWorkspacePhysicalLockManager({
  pool: lockDbPool,
  onReleaseError: (spaceId, error) => {
    logger.error("failed to finish workspace lock transaction; retiring the lock connection", { spaceId, error });
  },
});

export type WorkspacePhysicalLock = InfraWorkspacePhysicalLock;

export async function acquireWorkspacePhysicalLock(spaceId: string): Promise<WorkspacePhysicalLock | null> {
  return workspacePhysicalLocks.acquire(spaceId);
}
