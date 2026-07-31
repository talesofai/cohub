import type { RequestPrincipal } from "./lib/middleware.js";

export function spaceRoomReadPermission(
  principal: RequestPrincipal | null,
): "space.view" | "session.view" {
  return principal?.type === "user" ? "space.view" : "session.view";
}
