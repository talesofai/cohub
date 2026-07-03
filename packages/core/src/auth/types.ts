import type { AuthUserProfile } from "@cohub/identity";
import type { Permission } from "../permissions/index.js";

/** AuthUserProfile with guaranteed uuid (returned after auth checks pass). */
export type AuthUser = AuthUserProfile & { uuid: string };

export class UnauthorizedError extends Error {
  override name = "UnauthorizedError";
  constructor(message = "unauthorized") {
    super(message);
  }
}

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

export type WorkSessionPayload = {
  typ: "work_session";
  userUuid: string;
  workId: string;
  spaceId: string;
  workScopes: Permission[];
  viewerScopes: Permission[];
  scopes: Permission[];
  workViewerGrantId?: string;
  iat: number;
  exp: number;
};

export type WorkSessionPrincipal = WorkSessionPayload & { type: "work_session" };

export type RequestPrincipal =
  | { type: "user"; user: AuthUser }
  | { type: "execution"; execution: ExecutionAuthPrincipal }
  | { type: "work_session"; workSession: WorkSessionPrincipal };

/** Standard UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Short UUID (no hyphens): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx */
const SHORT_UUID_REGEX = /^[0-9a-f]{32}$/i;

export const requireValidId = (value: string | null | undefined) =>
  Boolean(value && (UUID_REGEX.test(value) || SHORT_UUID_REGEX.test(value)));
