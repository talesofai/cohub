import { createBatchDrizzlePermissionStore, hasPermission as hasSharedPermission, isUserLevelPermission, normalizePermissionScopes, resolvePermissionAccess as resolveSharedPermissionAccess, scopeListHasPermission } from "@cohub/core/permissions";
import { db } from "./db/index.js";
import type { AuthUserProfile } from "./auth.js";
import { workViewerGrants, type SpaceRole } from "@cohub/db";
import type { Permission, AccessPolicy, PermissionAccess } from "@cohub/core/permissions";
import type { PreviewSessionPrincipal } from "./preview-sessions.js";
import { hasPreviewSessionPermission } from "./preview-sessions.js";
import type { WorkSessionPrincipal } from "./work-sessions.js";
import { eq } from "drizzle-orm";

type CachedWorkSessionPrincipal = WorkSessionPrincipal & {
  activeViewerGrantScopes?: Promise<Permission[]>;
};

type ScopedExecutionPrincipal = {
  spaceId: string;
  scopes?: Permission[];
};

const permissionStore = createBatchDrizzlePermissionStore(db);

const identityKeys = (user: AuthUserProfile | null | undefined): string[] =>
  [...new Set([user?.uuid, user?.legacyUserUuid]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim()))];

export type { Audience, Permission } from "@cohub/core/permissions";

export async function getSpaceMemberRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
  return permissionStore.getSpaceMemberRole(spaceId, userId);
}

export async function getSpaceMemberRoleForUser(spaceId: string, user: AuthUserProfile | null): Promise<SpaceRole | null> {
  for (const key of identityKeys(user)) {
    const role = await getSpaceMemberRole(spaceId, key);
    if (role) return role;
  }
  return null;
}

const getUserWorkSession = (user: AuthUserProfile | null): CachedWorkSessionPrincipal | null => {
  const session = (user as (AuthUserProfile & { workSession?: CachedWorkSessionPrincipal }) | null)?.workSession;
  if (!session || !identityKeys(user).includes(session.userUuid)) return null;
  return session;
};

const getUserExecution = (user: AuthUserProfile | null): ScopedExecutionPrincipal | null => {
  const execution = (user as (AuthUserProfile & { execution?: ScopedExecutionPrincipal }) | null)?.execution;
  if (!execution || !Array.isArray(execution.scopes)) return null;
  return execution;
};

const getUserPreviewSession = (user: AuthUserProfile | null): PreviewSessionPrincipal | null => {
  const session = (user as (AuthUserProfile & { previewSession?: PreviewSessionPrincipal }) | null)?.previewSession;
  if (!session || !identityKeys(user).includes(session.userUuid)) return null;
  return session;
};

/**
 * Strip work/preview/execution principal scopes for account-level handlers
 * (`user.space.list` / `user.session.list` / `user.usage.read`).
 * Gate with the original principal; load data with this identity.
 */
export function asAccountIdentity(user: { uuid?: string | null; legacyUserUuid?: string | null } | null | undefined): { uuid: string; legacyUserUuid?: string } | null {
  const uuid = typeof user?.uuid === "string" ? user.uuid.trim() : "";
  if (!uuid) return null;
  const legacyUserUuid = typeof user?.legacyUserUuid === "string" ? user.legacyUserUuid.trim() : "";
  return legacyUserUuid ? { uuid, legacyUserUuid } : { uuid };
}

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

export async function hasPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  context: { spaceId: string; sessionId?: string },
): Promise<boolean> {
  // Account-level scopes are not bound to a space. Work sessions need an
  // explicit viewer grant; publishers cannot pre-grant these via workScopes.
  // Handlers then load rows with asAccountIdentity (user membership/policy),
  // not work-scoped session.view / space.view.
  if (isUserLevelPermission(permission)) {
    const workSession = getUserWorkSession(user);
    if (workSession) return hasActiveViewerGrantPermission(workSession, permission);
    return Boolean(user?.uuid);
  }

  const workSession = getUserWorkSession(user);
  if (workSession) return hasWorkSessionScopedPermission(workSession, permission, context.spaceId);
  const previewSession = getUserPreviewSession(user);
  if (previewSession) return hasPreviewSessionPermission(previewSession, permission, context.spaceId);
  const execution = getUserExecution(user);
  if (execution?.spaceId === context.spaceId && scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)) return true;
  return hasSharedPermission({
    store: permissionStore,
    user,
    permission,
    context,
  });
}

export async function getRoleForSpaceUser(spaceId: string, userId: string | { uuid: string; legacyUserUuid?: string }): Promise<SpaceRole | null> {
  if (typeof userId === "string") return getSpaceMemberRole(spaceId, userId);
  return getSpaceMemberRoleForUser(spaceId, userId);
}

export async function resolvePermissionAccess(
  user: AuthUserProfile | null,
  context: { spaceId: string; sessionId?: string },
): Promise<PermissionAccess> {
  const workSession = getUserWorkSession(user);
  if (workSession && workSession.spaceId === context.spaceId) {
    return { role: null, permissions: await resolveWorkSessionScopes(workSession) };
  }
  const previewSession = getUserPreviewSession(user);
  if (previewSession?.spaceId === context.spaceId) return { role: null, permissions: normalizePermissionScopes(previewSession.scopes) };
  const execution = getUserExecution(user);
  if (execution?.spaceId === context.spaceId) return { role: null, permissions: normalizePermissionScopes(execution.scopes ?? []) };
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
  const previewSession = getUserPreviewSession(user);
  if (previewSession) return hasPreviewSessionPermission(previewSession, permission, spaceId) ? sessions : [];
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

/**
 * Batch form of `hasPermission` for many spaces. Work/preview/execution
 * principals are scoped to a single space, so they only ever match that one;
 * ordinary users fall through to a 1–2 query membership + policy lookup.
 */
export async function filterSpaceIdsByPermission(
  user: AuthUserProfile | null,
  permission: Permission,
  spaceIds: readonly string[],
): Promise<string[]> {
  if (spaceIds.length === 0) return [];

  const workSession = getUserWorkSession(user);
  if (workSession) {
    return (await hasWorkSessionScopedPermission(workSession, permission, workSession.spaceId))
      ? spaceIds.filter((id) => id === workSession.spaceId)
      : [];
  }

  const previewSession = getUserPreviewSession(user);
  if (previewSession) {
    return hasPreviewSessionPermission(previewSession, permission, previewSession.spaceId)
      ? spaceIds.filter((id) => id === previewSession.spaceId)
      : [];
  }

  const execution = getUserExecution(user);
  if (execution) {
    return scopeListHasPermission(normalizePermissionScopes(execution.scopes ?? []), permission)
      ? spaceIds.filter((id) => id === execution.spaceId)
      : [];
  }

  return permissionStore.filterSpaceIdsByPermission({ user, permission, spaceIds });
}
