import type { RequestPrincipal } from "./lib/middleware.js";

export function spaceRoomReadPermission(
  principal: RequestPrincipal | null,
): "space.view" | null {
  return principal?.type === "user" ? "space.view" : null;
}

export async function filterReadableSpaceRoomIds(
  principal: RequestPrincipal | null,
  spaceIds: string[],
  filterByPermission: (permission: "space.view", spaceIds: string[]) => Promise<string[]>,
): Promise<string[]> {
  const permission = spaceRoomReadPermission(principal);
  return permission ? filterByPermission(permission, spaceIds) : [];
}
