import { createHash } from "node:crypto";
import type { SpaceRole } from "@cohub/db";

const invitationPublicId = (token: string) =>
  `invite_${createHash("sha256").update(token).digest("base64url")}`;

export function projectSpaceInvitation(
  input: {
    token: string;
    role: SpaceRole;
    status: string;
    useCount: number;
    maxUses: number | null;
    createdAt: string | null;
    expiresInSeconds: number | null;
  },
  canManage: boolean,
) {
  const { token, ...summary } = input;
  const projected = { id: invitationPublicId(token), ...summary };
  return canManage ? { token, ...projected } : projected;
}
