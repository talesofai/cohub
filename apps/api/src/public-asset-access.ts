import type { RequestPrincipal } from "./lib/middleware.js";
import type { Permission } from "@cohub/core/permissions";
import type { CreatePublicAssetUploadInput } from "./public-asset-storage.js";

export function resolvePublicAssetUploadActor(
  principal: RequestPrincipal | null,
  input: Pick<CreatePublicAssetUploadInput, "purpose" | "spaceId">,
): { userUuid: string; workSpaceId: string | null } | null {
  if (principal?.type === "user") {
    return { userUuid: principal.user.uuid, workSpaceId: null };
  }
  if (
    principal?.type === "work_session"
    && input.purpose === "chat_attachment"
    && (!input.spaceId || input.spaceId === principal.workSession.spaceId)
  ) {
    return {
      userUuid: principal.workSession.userUuid,
      workSpaceId: principal.workSession.spaceId,
    };
  }
  return null;
}

export async function canUploadWorkChatAttachment(
  checkPermission: (permission: Permission) => Promise<boolean>,
  options: { hasBoundSession: boolean },
): Promise<boolean> {
  if (await checkPermission("generation.create")) return true;
  return options.hasBoundSession
    && await checkPermission("session.prompt.readonly");
}
