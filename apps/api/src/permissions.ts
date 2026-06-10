import { createBatchDrizzlePermissionStore, hasPermission as hasSharedPermission, resolvePermissionAccess as resolveSharedPermissionAccess } from "@cohub/core/permissions";
import { db } from "./db/index.js";
import type { AuthUserProfile } from "./auth.js";
import { workViewerGrants, type SpaceRole } from "@cohub/db";
import type { Permission, AccessPolicy, PermissionAccess } from "@cohub/core/permissions";
import type { WorkSessionPrincipal } from "./work-sessions.js";
import { eq } from "drizzle-orm";

type CachedWorkSessionPrincipal = WorkSessionPrincipal & {
  activeViewerGrantScopes?: Promise<Permission[]>;
};

const permissionStore = createBatchDrizzlePermissionStore(db);

export type { Audience, Permission } from "@cohub/core/permissions";

export async function getSpaceMemberRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
  return permissionStore.getSpaceMemberRole(spaceId, userId);
}

const getUserWorkSession = (user: AuthUserProfile | null): CachedWorkSessionPrincipal | null => {
  const session = (user as (AuthUserProfile & { workSession?: CachedWorkSessionPrincipal }) | null)?.workSession;
  if (!session || user?.uuid !== session.userUuid) return null;
  return session;
};

const scopeListHasPermission = (scopes: readonly Permission[], permission: Permission) => {
  if (scopes.includes(permission)) return true;
  if (permission === "session.prompt.readonly" && scopes.includes("session.prompt.fullaccess")) return true;
  if (permission === "file.view.filtered" && scopes.includes("file.view")) return true;
  return false;
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
  const tokenScopes = new Set(workSession.viewerScopes);
  return (grant.scopes as Permission[]).filter((scope) => tokenScopes.has(scope));
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
  return Array.from(new Set([...workSession.workScopes, ...viewerScopes]));
};

const hasWorkSessionScopedPermission = async (workSession: CachedWorkSessionPrincipal, permission: Permission, spaceId: string) => {
  if (workSession.spaceId !== spaceId) return false;
  if (scopeListHasPermission(workSession.workScopes, permission)) return true;
  return hasActiveViewerGrantPermission(workSession, permission);
};

export async function hasPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  context: { spaceId: string; sessionId?: string },
): Promise<boolean> {
  const workSession = getUserWorkSession(user);
  if (workSession) return hasWorkSessionScopedPermission(workSession, permission, context.spaceId);
  return hasSharedPermission({
    store: permissionStore,
    user,
    permission,
    context,
  });
}

export async function getRoleForSpaceUser(spaceId: string, userId: string): Promise<SpaceRole | null> {
  return getSpaceMemberRole(spaceId, userId);
}

export async function resolvePermissionAccess(
  user: AuthUserProfile | null,
  context: { spaceId: string; sessionId?: string },
): Promise<PermissionAccess> {
  const workSession = getUserWorkSession(user);
  if (workSession && workSession.spaceId === context.spaceId) {
    return { role: null, permissions: await resolveWorkSessionScopes(workSession) };
  }
  return resolveSharedPermissionAccess({
    store: permissionStore,
    user,
    context,
  });
}

export async function getSessionSpaceId(sessionId: string): Promise<string | null> {
  return permissionStore.getSessionSpaceId(sessionId);
}

type SpaceSessionRow = typeof import("@cohub/db").spaceSessions.$inferSelect;
type AccessPolicyRow = AccessPolicy | null;

export async function filterSessionsByPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  spaceId: string,
  sessions: SpaceSessionRow[],
  spacePolicy?: AccessPolicyRow,
): Promise<SpaceSessionRow[]> {
  const workSession = getUserWorkSession(user);
  if (workSession) {
    return await hasWorkSessionScopedPermission(workSession, permission, spaceId) ? sessions : [];
  }
  return permissionStore.filterSessionsByPermission({
    user,
    permission,
    spaceId,
    sessions,
    spacePolicy,
  });
}
