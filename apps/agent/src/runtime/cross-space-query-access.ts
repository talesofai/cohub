import { eq } from "drizzle-orm";
import { createDrizzlePermissionStore, hasPermission, scopeListHasPermission } from "@cohub/core/permissions";
import { getPromptAuthScopes } from "@cohub/core/sessions";
import { spaces } from "@cohub/db";
import { db } from "../db.js";
import { assertValidSpaceId } from "./ids.js";
import type { AgentFileVisibility } from "./workspace-visibility.js";

const permissionStore = createDrizzlePermissionStore(db);

function visibilityFromPromptAuth(auth: unknown, spaceId: string): AgentFileVisibility | "denied" | null {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as { type?: unknown; spaceId?: unknown };
  if ((record.type !== "work_session" && record.type !== "delegated_prompt") || record.spaceId !== spaceId) return "denied";
  const scopes = getPromptAuthScopes(auth, spaceId);
  if (scopeListHasPermission(scopes, "file.view")) return "full";
  if (scopeListHasPermission(scopes, "file.view.filtered")) return "filtered";
  return "denied";
}

export async function resolveSpaceFileVisibility(input: {
  actorUserId: string;
  spaceId: string;
  promptAuth?: unknown;
}): Promise<AgentFileVisibility> {
  const spaceId = assertValidSpaceId(input.spaceId);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new Error("Space not found.");

  const promptAuthVisibility = visibilityFromPromptAuth(input.promptAuth, spaceId);
  if (promptAuthVisibility === "denied") throw new Error("File access denied.");
  if (promptAuthVisibility) return promptAuthVisibility;

  const user = { uuid: input.actorUserId };
  const context = { spaceId };
  const visibility = await hasPermission({ store: permissionStore, user, permission: "file.view", context })
    ? "full"
    : await hasPermission({ store: permissionStore, user, permission: "file.view.filtered", context })
      ? "filtered"
      : null;
  if (!visibility) throw new Error("File access denied.");
  return visibility;
}

export async function assertSpaceFileViewAccess(input: {
  actorUserId: string;
  spaceId: string;
  promptAuth?: unknown;
}): Promise<void> {
  await resolveSpaceFileVisibility(input);
}
