import type { Context } from "hono";

import { verifyExecutionGrant, type ExecutionGrantPayload } from "./execution-grants.js";
export type { LocalAgentAuthPrincipal } from "./local-agent-auth.js";
export type { AuthUserProfile } from "@cohub/identity";

const parseBearer = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const [scheme, token] = value.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
};

export const getTokenFromRequest = (c: Context) => {
  return parseBearer(c.req.header("authorization"));
};

export type ExecutionAuthPrincipal = {
  type: "execution";
  actorUserId: string | null;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  source: string;
  scopes: string[];
  expiresAt: number;
};

export const consumeExecutionAuthFromToken = async (token: string): Promise<ExecutionAuthPrincipal | null> => {
  const grant = await verifyExecutionGrant(token);
  if (!grant) return null;
  return toExecutionAuthPrincipal(grant);
};

function toExecutionAuthPrincipal(grant: ExecutionGrantPayload): ExecutionAuthPrincipal {
  return {
    type: "execution",
    actorUserId: grant.actorUserId,
    spaceId: grant.spaceId,
    sessionId: grant.sessionId,
    turnId: grant.turnId,
    source: grant.source,
    scopes: grant.scopes ?? [],
    expiresAt: grant.exp * 1000,
  };
}
