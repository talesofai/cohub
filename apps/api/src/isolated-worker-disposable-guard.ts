import { eq } from "drizzle-orm";
import { spaceSandboxes, spaces } from "@cohub/db";
import { db } from "./db/index.js";
import {
  createIsolatedWorkerDisposableGuard,
  createIsolatedWorkerDisposableRouteGuard,
} from "./isolated-worker-disposable-guard-domain.js";

export {
  IsolatedWorkerDisposableOperationError,
  type IsolatedWorkerDisposableOperation,
} from "./isolated-worker-disposable-guard-domain.js";

export const assertIsolatedWorkerDisposableOperationAllowed = createIsolatedWorkerDisposableGuard(
  async (spaceId) => {
    const [row] = await db
      .select({
        spaceMeta: spaces.meta,
        sandboxStatus: spaceSandboxes.status,
        sandboxMeta: spaceSandboxes.meta,
      })
      .from(spaces)
      .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
      .where(eq(spaces.id, spaceId))
      .limit(1);
    return row ?? null;
  },
);

export const rejectIsolatedWorkerDisposableRouteMutation = createIsolatedWorkerDisposableRouteGuard(
  assertIsolatedWorkerDisposableOperationAllowed,
);
