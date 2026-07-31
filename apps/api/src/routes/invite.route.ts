import { Hono } from "hono";
import { db } from "../db/index.js";
import { spaceMembers, spaces } from "@cohub/db";
import type { SpaceRole } from "@cohub/db";
import { isRoleHigherThan } from "@cohub/core/permissions";
import { and, eq } from "drizzle-orm";
import { redisCommandClient } from "../redis.js";
import { useAccountAuth } from "../lib/middleware.js";

const INVITE_PREFIX = "invite";

function inviteKey(token: string) {
  return `${INVITE_PREFIX}:${token}`;
}

const router = new Hono();

// ── GET /api/invite/:token ──────────────────────────────────────────────────
// Public: get invitation details (no auth required)

router.get("/:token", async (c) => {
  const token = c.req.param("token");
  const key = inviteKey(token);

  const exists = await redisCommandClient.exists(key);
  if (!exists) return c.json({ message: "invitation expired or not found" }, 410);

  const data = await redisCommandClient.hgetall(key);

  if (data.status === "revoked") {
    return c.json({ message: "invitation has been revoked" }, 410);
  }

  const maxUses = Number.parseInt(data.max_uses ?? "0", 10);
  const useCount = Number.parseInt(data.use_count ?? "0", 10);
  if (maxUses > 0 && useCount >= maxUses) {
    return c.json({ message: "invitation has reached its usage limit" }, 410);
  }

  const spaceId = data.space_id;
  if (!spaceId) return c.json({ message: "invitation expired or not found" }, 410);

  const ttl = await redisCommandClient.ttl(key);

  // Fetch space name fresh from DB (cache may be stale)
  const [space] = await db
    .select({ name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);

  return c.json({
    token,
    spaceId,
    spaceName: space?.name ?? data.space_name ?? "Unknown",
    role: data.role,
    expiresInSeconds: ttl > 0 ? ttl : null,
  });
});

// ── POST /api/invite/:token/accept ──────────────────────────────────────────
// Accept an invitation (auth required)

router.post("/:token/accept", async (c) => {
  const user = useAccountAuth(c);
  if (user instanceof Response) return user;
  if (user instanceof Response) return user;

  const token = c.req.param("token");
  const key = inviteKey(token);

  // Check invitation exists
  const exists = await redisCommandClient.exists(key);
  if (!exists) return c.json({ message: "invitation expired or not found" }, 410);

  // Use WATCH for optimistic locking to prevent race conditions
  await redisCommandClient.watch(key);

  const data = await redisCommandClient.hgetall(key);

  if (data.status === "revoked") {
    await redisCommandClient.unwatch();
    return c.json({ message: "invitation has been revoked" }, 410);
  }

  const maxUses = Number.parseInt(data.max_uses ?? "0", 10);
  const useCount = Number.parseInt(data.use_count ?? "0", 10);
  if (maxUses > 0 && useCount >= maxUses) {
    await redisCommandClient.unwatch();
    return c.json({ message: "invitation has reached its usage limit" }, 410);
  }

  const spaceId = data.space_id;
  const role = data.role as SpaceRole | undefined;
  if (!spaceId || !role) return c.json({ message: "invitation expired or not found" }, 410);

  // Check if user is already a member. Invite links may upgrade an existing
  // lower-role member, for example guest -> builder, but must never demote.
  const [existing] = await db
    .select({ id: spaceMembers.id, role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, user.uuid)))
    .limit(1);

  let acceptedRole = role;
  let consumedInviteUse = false;

  if (existing) {
    if (isRoleHigherThan(role, existing.role)) {
      await db
        .update(spaceMembers)
        .set({ role, updatedBy: user.uuid, updatedAt: new Date() })
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, user.uuid)));
      consumedInviteUse = true;
    } else {
      acceptedRole = existing.role;
    }
  } else {
    await db.insert(spaceMembers).values({
      spaceId: spaceId,
      userId: user.uuid,
      role,
      createdBy: user.uuid,
      updatedBy: user.uuid,
    });
    consumedInviteUse = true;
  }

  if (consumedInviteUse) {
    // Increment use count
    const newCount = await redisCommandClient.hincrby(key, "use_count", 1);

    // Check if max uses reached
    if (maxUses > 0 && newCount >= maxUses) {
      await redisCommandClient.hset(key, "status", "exhausted");
    }
  }

  await redisCommandClient.unwatch();

  // Fetch space info for response
  const [space] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);

  return c.json({
    ok: true,
    spaceId,
    spaceName: space?.name ?? "Unknown",
    role: acceptedRole,
  });
});

export default router;
