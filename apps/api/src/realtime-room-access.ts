import type { RequestPrincipal } from "./lib/middleware.js";

export function spaceRoomReadPermission(
  principal: RequestPrincipal | null,
): "space.view" | null {
  return principal?.type === "user" ? "space.view" : null;
}
