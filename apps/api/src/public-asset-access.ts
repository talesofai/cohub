import type { RequestPrincipal } from "./lib/middleware.js";
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
    && input.spaceId === principal.workSession.spaceId
  ) {
    return {
      userUuid: principal.workSession.userUuid,
      workSpaceId: principal.workSession.spaceId,
    };
  }
  return null;
}
