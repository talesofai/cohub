export * from "./types.js";
export * from "./principals.js";
export { createWorkSessions, WORK_SESSION_TTL_SECONDS, type WorkSessions } from "./work-sessions.js";
export { createPermissionChecker, type PermissionChecker } from "./permissions.js";
export type { Db } from "./db-type.js";
export type { Audience, Permission, PermissionAccess } from "../permissions/index.js";

import type { Context, Next } from "hono";
import { verifyUserAccessToken } from "@cohub/identity";
import { createLogger } from "@cohub/infra/logging";
import { createExecutionGrantService } from "../security/index.js";
import type { ExecutionGrantPayload } from "../security/execution-grants.js";
import { createWorkSessions } from "./work-sessions.js";
import type { ExecutionAuthPrincipal, RequestPrincipal } from "./types.js";

const logger = createLogger({ serviceName: "cohub-auth" });

/**
 * Wires up token parsing (Logto JWT + work-session JWT + execution grant)
 * into a single Hono middleware. Both api and fs-api use this so that
 * principal semantics stay identical.
 */
export function createTokenAuth(deps: {
  appEncryptionKey: string;
  logtoEndpoint: string;
}) {
  const workSessions = createWorkSessions({ appEncryptionKey: deps.appEncryptionKey });
  const executionGrantService = createExecutionGrantService({ signingKey: deps.appEncryptionKey });

  const parseBearer = (value?: string | null) => {
    if (!value) return null;
    const [scheme, token] = value.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) return null;
    return token;
  };

  const getTokenFromRequest = (c: Context) => parseBearer(c.req.header("authorization"));

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

  const consumeExecutionAuthFromToken = async (token: string): Promise<ExecutionAuthPrincipal | null> => {
    const grant = await executionGrantService.verifyExecutionGrant(token);
    if (!grant) return null;
    return toExecutionAuthPrincipal(grant);
  };

  const authMiddleware = async (c: Context, next: Next) => {
    const token = getTokenFromRequest(c);
    c.set("principal", null);

    if (token) {
      const executionAuth = await consumeExecutionAuthFromToken(token).catch((error) => {
        logger.warn("[auth] Failed to verify execution token:", error);
        return null;
      });
      if (executionAuth) {
        c.set("principal", { type: "execution", execution: executionAuth } satisfies RequestPrincipal);
        await next();
        return;
      }

      const workSession = workSessions.verifyWorkSessionToken(token);
      if (workSession) {
        c.set("principal", { type: "work_session", workSession } satisfies RequestPrincipal);
        await next();
        return;
      }

      try {
        const authUser = await verifyUserAccessToken({ token, logtoEndpoint: deps.logtoEndpoint });
        c.set("principal", { type: "user", user: authUser } satisfies RequestPrincipal);
      } catch {
        return c.json({ message: "unauthorized" }, 401);
      }
    }

    await next();
  };

  return { getTokenFromRequest, consumeExecutionAuthFromToken, authMiddleware, workSessions };
}

export type TokenAuth = ReturnType<typeof createTokenAuth>;
