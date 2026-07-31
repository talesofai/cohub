import type { SpaceRole } from "@cohub/db";

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
  return canManage ? { token, ...summary } : summary;
}
