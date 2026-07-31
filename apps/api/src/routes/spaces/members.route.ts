import { and, count, eq, inArray, or } from "drizzle-orm";
import { Hono } from "hono";
import { unbindSpaceChannelFromGateway } from "../../channels.js";
import { db } from "../../db/index.js";
import { spaceChannels, spaceMembers, userChannels, userProfiles } from "@cohub/db";
import type { SpaceRole } from "@cohub/db";
import { requireValidId, requireValidPrincipalId, useAuth, authzDenied } from "../../lib/middleware.js";
import { isRoleLowerThan } from "@cohub/core/permissions";
import { hasPermission, getRoleForSpaceUser } from "../../permissions.js";
import { getSpaceById } from "../../space-sessions.js";
import { fallbackPublicUserProfile } from "../../user-profiles.js";
import { createLogger } from "@cohub/infra/logging";
import { getIdentityKeys, resolveStoredPrincipalUser } from "../../identity-bridge.js";


const logger = createLogger({ serviceName: "cohub-api" });
const VALID_ROLES: SpaceRole[] = ["host", "builder", "guest"];
const router = new Hono();

async function isLastHost(spaceId: string): Promise<boolean> {
  const rows = await db
    .select({ count: count() })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, "host")));
  return (rows[0]?.count ?? 0) <= 1;
}

function cleanupGatewayBindings(spaceChannelIds: string[]) {
  for (const spaceChannelId of spaceChannelIds) {
    void unbindSpaceChannelFromGateway(spaceChannelId).catch((error) => logger.error("[SpaceMembers] failed to unbind removed member channel from gateway", error));
  }
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.view", { spaceId }))) return authzDenied(c);

  const items = await db
    .select({
      userId: spaceMembers.userId,
      role: spaceMembers.role,
      createdAt: spaceMembers.createdAt,
      updatedAt: spaceMembers.updatedAt,
      profile: {
        userUuid: userProfiles.logtoUserId,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
    })
    .from(spaceMembers)
    .leftJoin(userProfiles, or(
      eq(userProfiles.userUuid, spaceMembers.userId),
      eq(userProfiles.logtoUserId, spaceMembers.userId),
    ))
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(spaceMembers.createdAt);

  const canonicalItems = items.map((item) => {
      const profile = item.profile?.userUuid
        ? item.profile
        : fallbackPublicUserProfile(item.userId);
      return {
        ...item,
        userId: profile.userUuid,
        profile,
      };
    });
  if (new Set(canonicalItems.map((item) => item.userId)).size !== canonicalItems.length) {
    return c.json({ message: "member identity conflict requires repair" }, 409);
  }
  return c.json({ items: canonicalItems });
});

router.put("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.manage", { spaceId }))) return authzDenied(c);
  const actorRole = await getRoleForSpaceUser(spaceId, user);
  if (actorRole !== "host") return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ userId?: string; role?: SpaceRole }>().catch(() => null);
  if (!body?.userId || !body.role) return c.json({ message: "userId and role are required" }, 400);
  if (!requireValidPrincipalId(body.userId)) return c.json({ message: "userId must be a valid principal id" }, 400);
  if (!VALID_ROLES.includes(body.role)) return c.json({ message: "invalid role" }, 400);
  const targetIdentity = await resolveStoredPrincipalUser(body.userId).catch(() => null);
  if (!targetIdentity) return c.json({ message: "user identity is not resolvable" }, 409);
  const targetUserId = targetIdentity.uuid;
  const targetIdentityKeys = getIdentityKeys(targetIdentity);
  const newRole = body.role;

  const currentMembers = await db
    .select({ id: spaceMembers.id, role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, targetIdentityKeys)));
  if (currentMembers.length > 1) return c.json({ message: "member identity conflict requires repair" }, 409);
  const currentRole = currentMembers[0]?.role ?? null;
  if (currentRole === "host" && newRole !== "host") {
    if (await isLastHost(spaceId))
      return c.json({ message: "cannot demote the last host" }, 400);
  }

  const shouldUnbindChannels = Boolean(currentRole && isRoleLowerThan(newRole, currentRole));
  const { member, spaceChannelIdsToUnbind } = await db.transaction(async (tx) => {
    const existingMembers = await tx
      .select({ id: spaceMembers.id })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, targetIdentityKeys)))
      .for("update");
    if (existingMembers.length > 1) throw new Error("member identity conflict requires repair");
    const [updatedMember] = existingMembers[0]
      ? await tx.update(spaceMembers).set({
          userId: targetUserId,
          role: newRole,
          updatedBy: user.uuid,
          updatedAt: new Date(),
        }).where(eq(spaceMembers.id, existingMembers[0].id)).returning()
      : await tx.insert(spaceMembers).values({
        spaceId,
        userId: targetUserId,
        role: newRole,
        createdBy: user.uuid,
        updatedBy: user.uuid,
      }).returning();

    if (!shouldUnbindChannels) {
      return { member: updatedMember, spaceChannelIdsToUnbind: [] };
    }

    const channels = await tx
      .select({ id: spaceChannels.id })
      .from(spaceChannels)
      .innerJoin(userChannels, eq(userChannels.id, spaceChannels.channelId))
      .where(and(eq(spaceChannels.spaceId, spaceId), inArray(userChannels.userUuid, targetIdentityKeys)));
    const spaceChannelIds = channels.map((channel) => channel.id);
    if (spaceChannelIds.length > 0) {
      await tx.delete(spaceChannels).where(inArray(spaceChannels.id, spaceChannelIds));
    }

    return { member: updatedMember, spaceChannelIdsToUnbind: spaceChannelIds };
  });

  cleanupGatewayBindings(spaceChannelIdsToUnbind);

  return c.json(member);
});

router.delete("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.manage", { spaceId }))) return authzDenied(c);
  const actorRole = await getRoleForSpaceUser(spaceId, user);
  if (actorRole !== "host") return authzDenied(c);

  const body = await c.req.json<{ userId?: string }>().catch(() => null);
  if (!body?.userId || !requireValidPrincipalId(body.userId)) return c.json({ message: "userId is required" }, 400);
  const targetIdentity = await resolveStoredPrincipalUser(body.userId).catch(() => null);
  if (!targetIdentity) return c.json({ message: "user identity is not resolvable" }, 409);
  const targetIdentityKeys = getIdentityKeys(targetIdentity);

  const targetMembers = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, targetIdentityKeys)));
  if (targetMembers.length > 1) return c.json({ message: "member identity conflict requires repair" }, 409);
  const targetRole = targetMembers[0]?.role ?? null;
  if (!targetRole) return c.json({ ok: true });

  if (targetRole === "host" && await isLastHost(spaceId))
    return c.json({ message: "cannot remove the last host" }, 400);

  const spaceChannelIdsToUnbind = await db.transaction(async (tx) => {
    const channels = await tx
      .select({ id: spaceChannels.id })
      .from(spaceChannels)
      .innerJoin(userChannels, eq(userChannels.id, spaceChannels.channelId))
      .where(and(eq(spaceChannels.spaceId, spaceId), inArray(userChannels.userUuid, targetIdentityKeys)));
    const spaceChannelIds = channels.map((channel) => channel.id);

    if (spaceChannelIds.length > 0) {
      await tx.delete(spaceChannels).where(inArray(spaceChannels.id, spaceChannelIds));
    }
    await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, targetIdentityKeys)));

    return spaceChannelIds;
  });
  cleanupGatewayBindings(spaceChannelIdsToUnbind);

  return c.json({ ok: true });
});

export default router;
