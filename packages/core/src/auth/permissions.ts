import { eq } from "drizzle-orm";
import { workViewerGrants, type SpaceRole } from "@cohub/db";
import {
  createBatchDrizzlePermissionStore,
  hasPermission as hasSharedPermission,
  isUserLevelPermission,
  normalizePermissionScopes,
  resolvePermissionAccess as resolveSharedPermissionAccess,
  scopeListHasPermission,
  type Permission,
  type PermissionAccess,
} from "../permissions/index.js";
import type { AuthUser, WorkSessionPrincipal, ExecutionAuthPrincipal } from "./types.js";
import type { Db } from "./db-type.js";

type CachedWorkSessionPrincipal = WorkSessionPrincipal & {
  activeViewerGrantScopes?: Promise<Permission[]>;
};

type ScopedExecutionPrincipal = {
  spaceId: string;
  scopes?: Permission[];
};

export type { Permission, PermissionAccess };

export function createPermissionChecker({ db }: { db: Db }) {
  const permissionStore = createBatchDrizzlePermissionStore(db);

  async function getSpaceMemberRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
    return permissionStore.getSpaceMemberRole(spaceId, userId);
  }

  const getUserWorkSession = (user: AuthUser | null): CachedWorkSessionPrincipal | null => {
    const session = (user as (AuthUser & { workSession?: CachedWorkSessionPrincipal }) | null)?.workSession;
    if (!session || user?.uuid !== session.userUuid) return null;
    return session;
  };

  const getUserExecution = (user: AuthUser | null): ScopedExecutionPrincipal | null => {
    const execution = (user as (AuthUser & { execution?: ScopedExecutionPrincipal }) | null)?.execution;
    if (!execution || !Array.isArray(execution.scopes)) return null;
    return execution;
  };

  const loadActiveViewerGrantScopes = async (workSession: CachedWorkSessionPrincipal) => {
    if (!workSession.workViewerGrantId) return [] as Permission[];
    const [grant] = await db
      .select({ scopes: workViewerGrants.scopes, expiresAt: workViewerGrants.expiresAt, revokedAt: workViewerGrants.revokedAt })
      .from(workViewerGrants)
      .where(eq(workViewerGrants.id, workSession.workViewerGrantId))
      .limit(1);
    if (!grant || grant.revokedAt) return [];
    if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) return [];
    const tokenScopes = new Set(normalizePermissionScopes(workSession.viewerScopes));
    return normalizePermissionScopes(grant.scopes as string[]).filter((scope) => tokenScopes.has(scope));
  };

  const getActiveViewerGrantScopes = async (workSession: CachedWorkSessionPrincipal) => {
    workSession.activeViewerGrantScopes ??= loadActiveViewerGrantScopes(workSession);
    return workSession.activeViewerGrantScopes;
  };

  const hasActiveViewerGrantPermission = async (workSession: CachedWorkSessionPrincipal, permission: Permission) => {
    if (!scopeListHasPermission(workSession.viewerScopes, permission)) return false;
    return scopeListHasPermission(await getActiveViewerGrantScopes(workSession), permission);
  };

  const resolveWorkSessionScopes = async (workSession: CachedWorkSessionPrincipal) => {
    const viewerScopes = await getActiveViewerGrantScopes(workSession);
    return normalizePermissionScopes([...workSession.workScopes, ...viewerScopes]);
  };

  const hasWorkSessionScopedPermission = async (workSession: CachedWorkSessionPrincipal, permission: Permission, spaceId: string) => {
    if (workSession.spaceId !== spaceId) return false;
    if (scopeListHasPermission(workSession.workScopes, permission)) return true;
    return hasActiveViewerGrantPermission(workSession, permission);
  };

  async function hasPermission(
    user: AuthUser | null,
    permission: Permission,
    context: { spaceId: string; sessionId?: string },
  ): Promise<boolean> {
    if (isUserLevelPermission(permission)) {
      const workSession = getUserWorkSession(user);
      if (workSession) return hasActiveViewerGrantPermission(workSession, permission);
      return Boolean(user?.uuid);
    }

    const workSession = getUserWorkSession(user);
    if (workSession) return hasWorkSessionScopedPermission(workSession, permission, context.spaceId);
    const execution = getUserExecution(user);
    if (execution?.spaceId === context.spaceId && scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)) return true;
    return hasSharedPermission({
      store: permissionStore,
      user,
      permission,
      context,
    });
  }

  async function getRoleForSpaceUser(spaceId: string, userId: string): Promise<SpaceRole | null> {
    return getSpaceMemberRole(spaceId, userId);
  }

  async function resolvePermissionAccess(
    user: AuthUser | null,
    context: { spaceId: string; sessionId?: string },
  ): Promise<PermissionAccess> {
    const workSession = getUserWorkSession(user);
    if (workSession && workSession.spaceId === context.spaceId) {
      return { role: null, permissions: await resolveWorkSessionScopes(workSession) };
    }
    const execution = getUserExecution(user);
    if (execution?.spaceId === context.spaceId) return { role: null, permissions: normalizePermissionScopes(execution.scopes ?? []) };
    return resolveSharedPermissionAccess({
      store: permissionStore,
      user,
      context,
    });
  }

  async function getSessionSpaceId(sessionId: string): Promise<string | null> {
    return permissionStore.getSessionSpaceId(sessionId);
  }

  type SpaceSessionRow = typeof import("@cohub/db").spaceSessions.$inferSelect;
  type AccessPolicyRow = AccessPolicy | null;
  type AccessPolicy = import("../permissions/index.js").AccessPolicy;

  async function filterSessionsByPermission(
    user: AuthUser | null,
    permission: Permission,
    spaceId: string,
    sessions: SpaceSessionRow[],
    spacePolicy?: AccessPolicyRow,
  ): Promise<SpaceSessionRow[]> {
    const workSession = getUserWorkSession(user);
    if (workSession) {
      return await hasWorkSessionScopedPermission(workSession, permission, spaceId) ? sessions : [];
    }
    const execution = getUserExecution(user);
    if (execution?.spaceId === spaceId) return scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission) ? sessions : [];
    return permissionStore.filterSessionsByPermission({
      user,
      permission,
      spaceId,
      sessions,
      spacePolicy,
    });
  }

  return {
    hasPermission,
    getRoleForSpaceUser,
    getSpaceMemberRole,
    resolvePermissionAccess,
    getSessionSpaceId,
    filterSessionsByPermission,
  };
}

export type PermissionChecker = ReturnType<typeof createPermissionChecker>;
