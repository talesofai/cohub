import type { OwnerResourcePrincipal } from "./owner-resource-access.js";
import type { WorkSessionPrincipal } from "./work-sessions.js";

export type InternalPromptPrincipalType = "user" | "work_session";

export function resolveInternalPromptActor(
  input: {
    principalType: InternalPromptPrincipalType;
    userId: string;
    authToken: string;
  },
  verifyWorkToken: (token: string) => WorkSessionPrincipal | null,
): {
  principal: Exclude<OwnerResourcePrincipal, null>;
  permissionSubject: { uuid: string; workSession?: WorkSessionPrincipal };
  workSession: WorkSessionPrincipal | null;
} | null {
  if (!input.authToken) return null;
  if (input.principalType === "user") {
    return {
      principal: { type: "user", user: { uuid: input.userId } },
      permissionSubject: { uuid: input.userId },
      workSession: null,
    };
  }

  const workSession = verifyWorkToken(input.authToken);
  if (!workSession || workSession.userUuid !== input.userId) return null;
  return {
    principal: { type: "work_session", workSession },
    permissionSubject: { uuid: input.userId, workSession },
    workSession,
  };
}
