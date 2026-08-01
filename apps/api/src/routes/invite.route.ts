import { Hono } from "hono";
import { db } from "../db/index.js";
import { spaceMembers, spaces } from "@cohub/db";
import type { SpaceRole } from "@cohub/db";
import { and, eq, sql } from "drizzle-orm";
import { redisCommandClient } from "../redis.js";
import { authzDenied, getRequestPrincipal, requireValidId } from "../lib/middleware.js";
import {
  invitationMembershipLockId,
  InvitationLockTimeoutError,
  withInvitationDatabaseLock,
  withInvitationLock,
} from "../invitation-lock.js";
import {
  acceptInvitationMembership,
  finalizeInvitationUse,
  hasInvitationUseReservation,
  invitationUseAvailability,
  reconcileExpiredInvitationUses,
  releaseInvitationUse,
  reserveInvitationUse,
} from "../invitation-acceptance.js";
import { invitationAccountUser } from "../space-invitation-access.js";

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

  const availability = invitationUseAvailability(data);
  if (availability === "revoked") {
    return c.json({ message: "invitation has been revoked" }, 410);
  }
  if (availability === "exhausted") {
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
  const user = invitationAccountUser(getRequestPrincipal(c));
  if (!user) return authzDenied(c);

  const token = c.req.param("token");
  const key = inviteKey(token);
  let accepted: Response | { spaceId: string; role: SpaceRole };
  try {
    accepted = await withInvitationLock(token, async () => {
      const result = await withInvitationDatabaseLock(token, async (transaction) => {
      const exists = await redisCommandClient.exists(key);
      if (!exists) return c.json({ message: "invitation expired or not found" }, 410);

      let data = await redisCommandClient.hgetall(key);
      const spaceId = data.space_id;
      const role = data.role as SpaceRole | undefined;
      if (!spaceId || !requireValidId(spaceId) || !role) {
        return c.json({ message: "invitation expired or not found" }, 410);
      }
      await reconcileExpiredInvitationUses(
        key,
        data,
        async (reservedUserUuid) => {
          const [existing] = await transaction
            .select({ role: spaceMembers.role })
            .from(spaceMembers)
            .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, reservedUserUuid)))
            .limit(1);
          return existing?.role ?? null;
        },
        redisCommandClient,
      );
      data = await redisCommandClient.hgetall(key);
      const availability = invitationUseAvailability(data, user.uuid);
      if (availability === "revoked") {
        return c.json({ message: "invitation has been revoked" }, 410);
      }
      if (availability === "pending") {
        return c.json({ message: "invitation acceptance is still being recovered, please try again" }, 503);
      }
      if (availability === "exhausted") {
        return c.json({ message: "invitation has reached its usage limit" }, 410);
      }

      const membership = await withInvitationLock(
        invitationMembershipLockId(spaceId, user.uuid),
        () => acceptInvitationMembership(role, {
          getRole: async () => {
            const [existing] = await transaction
              .select({ role: spaceMembers.role })
              .from(spaceMembers)
              .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, user.uuid)))
              .limit(1);
            return existing?.role ?? null;
          },
          hasReservedUse: async () => hasInvitationUseReservation(data, user.uuid),
          reserveUse: () => reserveInvitationUse(key, user.uuid, role, redisCommandClient),
          applyRole: async () => {
            const [member] = await transaction.insert(spaceMembers).values({
              spaceId,
              userId: user.uuid,
              role,
              createdBy: user.uuid,
              updatedBy: user.uuid,
            }).onConflictDoUpdate({
              target: [spaceMembers.spaceId, spaceMembers.userId],
              set: {
                role: sql<SpaceRole>`CASE
                  WHEN ${spaceMembers.role} = 'host' OR ${role} = 'host' THEN 'host'
                  WHEN ${spaceMembers.role} = 'builder' OR ${role} = 'builder' THEN 'builder'
                  ELSE 'guest'
                END`,
                updatedBy: user.uuid,
                updatedAt: new Date(),
              },
            }).returning({ role: spaceMembers.role });
            if (!member) throw new Error("failed to apply invitation membership");
            return member.role;
          },
          releaseUse: () => releaseInvitationUse(key, user.uuid, redisCommandClient),
        }),
        redisCommandClient,
      );
      switch (membership.state) {
        case "missing":
          return c.json({ message: "invitation expired or not found" }, 410);
        case "revoked":
          return c.json({ message: "invitation has been revoked" }, 410);
        case "exhausted":
          return c.json({ message: "invitation has reached its usage limit" }, 410);
        case "used":
          return c.json({ message: "invitation has already been used" }, 410);
        case "accepted":
          return { spaceId, role: membership.role, pendingFinalization: membership.pendingFinalization };
      }
      });
      if (result instanceof Response) return result;
      if (result.pendingFinalization) {
        const finalization = await finalizeInvitationUse(key, user.uuid, redisCommandClient);
        if (finalization === "absent" || finalization === "missing") {
          throw new Error("invitation reservation was lost after membership committed");
        }
      }
      return { spaceId: result.spaceId, role: result.role };
    }, redisCommandClient);
  } catch (error) {
    if (error instanceof InvitationLockTimeoutError) {
      return c.json({ message: "invitation is busy, please try again" }, 503);
    }
    throw error;
  }
  if (accepted instanceof Response) return accepted;

  // Fetch space info for response
  const [space] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, accepted.spaceId))
    .limit(1);

  return c.json({
    ok: true,
    spaceId: accepted.spaceId,
    spaceName: space?.name ?? "Unknown",
    role: accepted.role,
  });
});

export default router;
