import {
  normalizePermissionScopes,
  scopeListHasPermission,
  type Permission,
} from "@cohub/core/permissions";
import {
  getPromptAuthScopes,
  type PromptAuthContext,
} from "@cohub/core/sessions";

export type WorkViewerGrantSnapshot = {
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export async function resolveScheduledPromptAuth(
  auth: PromptAuthContext | null | undefined,
  input: {
    spaceId: string;
    userId: string;
    requiredPermission: Permission;
  },
  loadGrant: (input: {
    grantId: string;
    workId: string;
    spaceId: string;
    viewerUserUuid: string;
  }) => Promise<WorkViewerGrantSnapshot | null>,
  now = Date.now(),
): Promise<PromptAuthContext | null> {
  if (!auth) return null;
  if (auth.type !== "delegated_prompt" || auth.spaceId !== input.spaceId) {
    throw new Error("delegated prompt authorization is invalid");
  }
  if (auth.actorUserId !== input.userId) {
    throw new Error("delegated prompt actor does not match task owner");
  }
  const tokenScopes = getPromptAuthScopes(auth, input.spaceId, () => now);
  if (!scopeListHasPermission(tokenScopes, input.requiredPermission)) {
    throw new Error("delegated prompt authorization expired or lacks permission");
  }
  if (auth.source !== "work_session") return auth;

  const workId = auth.workId?.trim();
  const grantId = auth.workViewerGrantId?.trim();
  if (!workId || !grantId) throw new Error("delegated Work grant is missing");
  const grant = await loadGrant({
    grantId,
    workId,
    spaceId: input.spaceId,
    viewerUserUuid: input.userId,
  });
  if (!grant || grant.revokedAt || (grant.expiresAt && grant.expiresAt.getTime() <= now)) {
    throw new Error("delegated Work grant is no longer active");
  }

  const tokenViewerScopes = normalizePermissionScopes(auth.viewerScopes);
  const grantScopes = normalizePermissionScopes(grant.scopes);
  if (
    !scopeListHasPermission(tokenViewerScopes, input.requiredPermission)
    || !scopeListHasPermission(grantScopes, input.requiredPermission)
  ) {
    throw new Error("delegated Work grant no longer allows this prompt");
  }

  const tokenViewerScopeSet = new Set(tokenViewerScopes);
  const viewerScopes = grantScopes.filter((scope) => tokenViewerScopeSet.has(scope));
  const tokenScopeSet = new Set(normalizePermissionScopes(auth.scopes));
  const scopes = normalizePermissionScopes([...auth.workScopes, ...viewerScopes])
    .filter((scope) => tokenScopeSet.has(scope));
  if (!scopeListHasPermission(scopes, input.requiredPermission)) {
    throw new Error("delegated Work grant no longer allows this prompt");
  }
  return { ...auth, scopes, viewerScopes };
}
