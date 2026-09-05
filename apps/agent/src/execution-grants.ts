import { createExecutionGrantService } from "@cohub/core/security";
import { env } from "./env.js";

const service = createExecutionGrantService({ signingKey: env.APP_ENCRYPTION_KEY });

export async function createAgentExecutionToken(input: {
  actorUserId: string;
  viewerUserId?: string | null;
  appId?: string | null;
  appVersionId?: string | null;
  action?: string | null;
  taskRunId?: string | null;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  source: string;
  scopes?: string[];
}) {
  const grant = await service.createExecutionGrant({
    actorUserId: input.actorUserId,
    viewerUserId: input.viewerUserId,
    appId: input.appId,
    appVersionId: input.appVersionId,
    action: input.action,
    taskRunId: input.taskRunId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source,
    scopes: input.scopes,
  });
  return grant.token;
}
