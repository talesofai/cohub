import type { SpaceRole } from "@cohub/db";
import type { AuthUser, RequestPrincipal } from "./lib/middleware.js";

export function invitationAccountUser(principal: RequestPrincipal | null): AuthUser | null {
  return principal?.type === "user" ? principal.user : null;
}

export function canManageSpaceInvitations(
  principal: RequestPrincipal | null,
  role: SpaceRole | null,
): boolean {
  return invitationAccountUser(principal) !== null && role === "host";
}

export function canViewSpaceInvitations(
  principal: RequestPrincipal | null,
  hasMemberView: boolean,
): boolean {
  return invitationAccountUser(principal) !== null && hasMemberView;
}
