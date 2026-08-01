import { Hono } from "hono";
import { redisCommandClient } from "../../redis.js";
import { authzDenied, getRequestPrincipal, requireValidId } from "../../lib/middleware.js";
import { getSpaceById } from "../../space-sessions.js";
import { getRoleForSpaceUser, hasPermission } from "../../permissions.js";
import type { SpaceRole } from "@cohub/db";
import { projectSpaceInvitation } from "../../space-invitation-view.js";
import {
  InvitationLockTimeoutError,
  withInvitationDatabaseLock,
  withInvitationLock,
} from "../../invitation-lock.js";
import {
  canManageSpaceInvitations,
  canViewSpaceInvitations,
  invitationAccountUser,
} from "../../space-invitation-access.js";

const VALID_ROLES: SpaceRole[] = ["host", "builder", "guest"];
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const INVITE_PREFIX = "invite";

function inviteKey(token: string) {
  return `${INVITE_PREFIX}:${token}`;
}

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `inv_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const router = new Hono();

// ── POST /api/spaces/:id/invitations ────────────────────────────────────────
// Create a new invitation link

router.post("/", async (c) => {
  const principal = getRequestPrincipal(c);
  const user = invitationAccountUser(principal);
  if (!user) return authzDenied(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  // Only hosts can create invitations
  const actorRole = await getRoleForSpaceUser(spaceId, user.uuid);
  if (!canManageSpaceInvitations(principal, actorRole)) {
    return c.json({ message: "forbidden" }, 403);
  }

  const body = await c.req.json<{
    role?: SpaceRole;
    ttlSeconds?: number;
    maxUses?: number;
  }>().catch(() => null);

  const role = body?.role ?? "builder";
  if (!VALID_ROLES.includes(role)) return c.json({ message: "invalid role" }, 400);

  const ttlSeconds = body?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (ttlSeconds <= 0 || ttlSeconds > 30 * 24 * 60 * 60) {
    return c.json({ message: "ttlSeconds must be between 1 and 30 days" }, 400);
  }

  const maxUses = body?.maxUses ?? 0; // 0 = unlimited
  if (maxUses < 0) return c.json({ message: "maxUses must be non-negative" }, 400);

  const token = generateToken();
  const key = inviteKey(token);

  await redisCommandClient.hset(key, {
    space_id: spaceId,
    space_name: space.name,
    creator_id: user.uuid,
    role,
    max_uses: String(maxUses),
    use_count: "0",
    status: "active",
    created_at: new Date().toISOString(),
  });
  await redisCommandClient.expire(key, ttlSeconds);

  // Track token in per-space set for efficient listing
  const spaceInviteKey = `${INVITE_PREFIX}:space:${spaceId}`;
  await redisCommandClient.sadd(spaceInviteKey, token);
  await redisCommandClient.expire(spaceInviteKey, ttlSeconds);

  return c.json({
    token,
    role,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    maxUses: maxUses || null,
  }, 201);
});

// ── GET /api/spaces/:id/invitations ─────────────────────────────────────────
// List active invitations for this space

router.get("/", async (c) => {
  const principal = getRequestPrincipal(c);
  const user = invitationAccountUser(principal);
  if (!user) return authzDenied(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [hasMemberView, hasMemberManage] = await Promise.all([
    hasPermission(user, "member.view", { spaceId }),
    hasPermission(user, "member.manage", { spaceId }),
  ]);
  if (!canViewSpaceInvitations(principal, hasMemberView)) {
    return c.json({ message: "forbidden" }, 403);
  }

  // Scan for invite keys belonging to this space
  const spaceInviteKey = `${INVITE_PREFIX}:space:${spaceId}`;
  const tokens = await redisCommandClient.smembers(spaceInviteKey);

  const invitations = [];
  for (const token of tokens) {
    const key = inviteKey(token);
    const exists = await redisCommandClient.exists(key);
    if (!exists) {
      // Token expired, clean up from set
      await redisCommandClient.srem(spaceInviteKey, token);
      continue;
    }

    const data = await redisCommandClient.hgetall(key);
    const ttl = await redisCommandClient.ttl(key);

    invitations.push(projectSpaceInvitation({
      token,
      role: data.role as SpaceRole,
      status: data.status ?? "unknown",
      useCount: Number.parseInt(data.use_count ?? "0", 10),
      maxUses: Number.parseInt(data.max_uses ?? "0", 10) || null,
      createdAt: data.created_at ?? null,
      expiresInSeconds: ttl > 0 ? ttl : null,
    }, hasMemberManage));
  }

  return c.json({ items: invitations });
});

// ── DELETE /api/spaces/:id/invitations/:token ───────────────────────────────
// Revoke an invitation

router.delete("/:token", async (c) => {
  const principal = getRequestPrincipal(c);
  const user = invitationAccountUser(principal);
  if (!user) return authzDenied(c);
  const spaceId = c.req.param("id");
  const token = c.req.param("token");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const actorRole = await getRoleForSpaceUser(spaceId, user.uuid);
  if (!canManageSpaceInvitations(principal, actorRole)) {
    return c.json({ message: "forbidden" }, 403);
  }

  try {
    const revoked = await withInvitationLock(token, () => withInvitationDatabaseLock(token, async () => {
      const key = inviteKey(token);
      const exists = await redisCommandClient.exists(key);
      if (!exists) return c.json({ message: "invitation not found" }, 404);

      const data = await redisCommandClient.hgetall(key);
      if (data.space_id !== spaceId) return c.json({ message: "invitation not found" }, 404);

      await redisCommandClient.hset(key, "status", "revoked");
      return c.json({ ok: true });
    }), redisCommandClient);
    return revoked;
  } catch (error) {
    if (error instanceof InvitationLockTimeoutError) {
      return c.json({ message: "invitation is busy, please try again" }, 503);
    }
    throw error;
  }
});

export default router;
