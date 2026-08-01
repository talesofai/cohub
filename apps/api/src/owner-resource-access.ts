import type { Permission } from "@cohub/core/permissions";
import { GENERATION_TASK_TYPE } from "@cohub/protocol/generation";

export type OwnerResourcePrincipal =
  | { type: "user"; user: { uuid: string } }
  | { type: "work_session"; workSession: { userUuid: string; spaceId: string; workId: string } }
  | { type: "preview_session"; previewSession: { userUuid: string; spaceId: string } }
  | { type: "execution"; execution: { actorUserId: string | null; spaceId: string } }
  | null;
type SessionResource = { id: string; spaceId: string; userUuid: string | null };
type TaskResource = {
  taskType: string;
  spaceId: string | null;
  sessionId: string | null;
  userUuid: string | null;
  payload?: unknown;
};
type PermissionCheck = (
  permission: Permission,
  context: { spaceId: string; sessionId?: string },
) => Promise<boolean>;

function ownsResource(
  principal: OwnerResourcePrincipal,
  resource: { spaceId: string | null; userUuid: string | null },
): boolean {
  if (!resource.userUuid) return false;
  if (principal?.type === "user") return principal.user.uuid === resource.userUuid;
  return Boolean(
    principal?.type === "work_session"
    && resource.spaceId
    && principal.workSession.userUuid === resource.userUuid
    && principal.workSession.spaceId === resource.spaceId
  );
}

export function ownerTaskListScope(principal: OwnerResourcePrincipal): {
  userUuid: string;
  spaceId: string | null;
  workId: string | null;
  requiresGenerationGrant: boolean;
} | null {
  if (principal?.type === "user") {
    return { userUuid: principal.user.uuid, spaceId: null, workId: null, requiresGenerationGrant: false };
  }
  if (principal?.type === "work_session") {
    return {
      userUuid: principal.workSession.userUuid,
      spaceId: principal.workSession.spaceId,
      workId: principal.workSession.workId,
      requiresGenerationGrant: true,
    };
  }
  return null;
}

export function ownerTaskListTaskType(
  scope: NonNullable<ReturnType<typeof ownerTaskListScope>>,
  requestedTaskType: string | null | undefined,
): string | undefined | null {
  const requested = requestedTaskType?.trim() || undefined;
  if (!scope.requiresGenerationGrant) return requested;
  if (requested && requested !== GENERATION_TASK_TYPE) return null;
  return GENERATION_TASK_TYPE;
}

export function minimalOwnerSessionSpace<T extends { id: string; name: string | null }>(space: T) {
  return {
    id: space.id,
    name: space.name,
    accessLevel: "minimal" as const,
  };
}

export function ownerSessionSummary<T extends {
  id: string;
  spaceId: string;
  userUuid: string | null;
  userProfile?: unknown;
  title: string | null;
  source: string | null;
  status: string | null;
  lastMessageAt: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  space?: unknown;
}>(session: T) {
  return {
    accessLevel: "summary" as const,
    id: session.id,
    spaceId: session.spaceId,
    userUuid: session.userUuid,
    userProfile: session.userProfile,
    participantUserUuids: [],
    participantProfiles: [],
    title: session.title,
    source: session.source,
    status: session.status,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    space: session.space,
  };
}

/** Work list rows are owner-visible across Spaces, or view-visible in-bound. */
export function canIncludeWorkSessionListRow(
  workSession: { userUuid: string; spaceId: string },
  session: { userUuid: string | null; spaceId: string },
  hasSessionView: boolean,
): boolean {
  return session.userUuid === workSession.userUuid
    || (hasSessionView && session.spaceId === workSession.spaceId);
}

/** Full Work list records never escape the token's bound Space. */
export function canExposeWorkSessionRecord(
  workSession: { spaceId: string },
  session: { spaceId: string },
  hasSessionView: boolean,
): boolean {
  return hasSessionView && workSession.spaceId === session.spaceId;
}

export async function canReadSessionResource(
  principal: OwnerResourcePrincipal,
  session: SessionResource,
  checkPermission: PermissionCheck,
): Promise<boolean> {
  if (await checkPermission("session.view", { spaceId: session.spaceId, sessionId: session.id })) return true;
  return canReadSessionResourceAfterViewDenied(principal, session, checkPermission);
}

export async function canReadSessionResourceAfterViewDenied(
  principal: OwnerResourcePrincipal,
  session: SessionResource,
  checkPermission: PermissionCheck,
): Promise<boolean> {
  if (!ownsResource(principal, session)) return false;
  if (principal?.type === "user") return true;
  return await checkPermission("session.prompt.readonly", {
    spaceId: session.spaceId,
    sessionId: session.id,
  }) || await checkPermission("session.prompt.fullaccess", {
    spaceId: session.spaceId,
    sessionId: session.id,
  });
}

export async function canBindGenerationToSession(
  principal: OwnerResourcePrincipal,
  session: SessionResource,
  checkPermission: PermissionCheck,
): Promise<boolean> {
  if (principal?.type === "work_session") return ownsResource(principal, session);
  if (ownsResource(principal, session)) return true;
  return checkPermission("session.view", { spaceId: session.spaceId, sessionId: session.id });
}

export async function canWriteSessionResource(
  principal: OwnerResourcePrincipal,
  session: SessionResource,
  permission: Permission,
  checkPermission: PermissionCheck,
): Promise<boolean> {
  if (!(await checkPermission(permission, { spaceId: session.spaceId, sessionId: session.id }))) {
    return false;
  }
  return principal?.type !== "work_session" || ownsResource(principal, session);
}

function taskWorkId(task: TaskResource): string | null {
  if (!task.payload || typeof task.payload !== "object" || Array.isArray(task.payload)) return null;
  const data = (task.payload as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const workId = (data as { workId?: unknown }).workId;
  return typeof workId === "string" && workId.trim() ? workId.trim() : null;
}

export async function canReadTaskResource(
  principal: OwnerResourcePrincipal,
  task: TaskResource,
  checkPermission: PermissionCheck,
): Promise<boolean> {
  if (principal?.type === "work_session") {
    if (
      task.taskType !== GENERATION_TASK_TYPE
      || !task.spaceId
      || principal.workSession.userUuid !== task.userUuid
      || principal.workSession.spaceId !== task.spaceId
      || taskWorkId(task) !== principal.workSession.workId
    ) {
      return false;
    }
    return checkPermission("generation.create", { spaceId: task.spaceId });
  }

  if (ownsResource(principal, task)) {
    if (principal?.type === "user") return true;
  }
  if (!task.spaceId) return false;
  return checkPermission("taskrun.view", {
    spaceId: task.spaceId,
    sessionId: task.sessionId ?? undefined,
  });
}
