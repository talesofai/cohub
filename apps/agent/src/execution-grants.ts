import { createExecutionGrantService } from "@cohub/core/security";
import { env } from "./env.js";

const service = createExecutionGrantService({ signingKey: env.APP_ENCRYPTION_KEY });

export async function createAgentExecutionToken(input: {
  actorUserId: string;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  source: string;
  scopes?: string[];
  authorizationMode?: "account" | "restricted";
}) {
  const grant = await service.createExecutionGrant({
    actorUserId: input.actorUserId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source,
    scopes: input.scopes,
    authorizationMode: input.authorizationMode,
  });
  return grant.token;
}
