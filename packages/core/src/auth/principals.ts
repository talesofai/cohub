import type { Context } from "hono";
import { UnauthorizedError } from "./types.js";
import type { AuthUser, RequestPrincipal, ExecutionAuthPrincipal, WorkSessionPrincipal } from "./types.js";

export const principalToAuthUser = (principal: RequestPrincipal | null | undefined): AuthUser | null => {
  if (principal?.type === "user") return principal.user;
  if (principal?.type === "execution" && principal.execution.actorUserId) {
    return {
      uuid: principal.execution.actorUserId,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      execution: principal.execution,
    } as AuthUser & { execution: ExecutionAuthPrincipal };
  }
  if (principal?.type === "work_session") {
    return {
      uuid: principal.workSession.userUuid,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      workSession: principal.workSession,
    } as AuthUser & { workSession: WorkSessionPrincipal };
  }
  return null;
};

/**
 * Returns the authenticated user or throws UnauthorizedError.
 * Callers should use `useAuth(c)` for a type-safe return.
 */
export const requireAuth = (c: Context): AuthUser => {
  const user = getOptionalAuth(c);
  if (user) return user;
  throw new UnauthorizedError("unauthorized");
};

/**
 * Type-safe auth check: returns AuthUser directly.
 * Usage: `const user = useAuth(c);`
 */
export const useAuth = (c: Context): AuthUser => {
  return requireAuth(c);
};

/**
 * Returns the authenticated user when present, otherwise null.
 * Use this for routes whose authorization is fully determined by RBAC
 * policies, including signed-in and anonymous access policies.
 */
export const getOptionalAuth = (c: Context): AuthUser | null => {
  return principalToAuthUser(c.get("principal") as RequestPrincipal | null | undefined);
};

export const authzDenied = (c: Context) => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal ? c.json({ message: "forbidden" }, 403) : c.json({ message: "unauthorized" }, 401);
};

export const getExecutionPrincipal = (c: Context): ExecutionAuthPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "execution" ? principal.execution : null;
};

export const getWorkSessionPrincipal = (c: Context): WorkSessionPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "work_session" ? principal.workSession : null;
};
