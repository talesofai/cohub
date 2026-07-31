import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { spaceMembers, spaces } from "@cohub/db";
import type { SpaceRole } from "@cohub/db";
import { isRoleHigherThan } from "@cohub/core/permissions";
import { and, eq } from "drizzle-orm";
import { redisCommandClient } from "../redis.js";
import { useAccountAuth } from "../lib/middleware.js";
import { createLogger } from "@cohub/infra/logging";

const INVITE_PREFIX = "invite";
const logger = createLogger({ serviceName: "cohub-api" });
const INVITE_LOCK_TTL_MS = 30_000;
const INVITE_LOCK_WAIT_MS = 5_000;
const INVITE_LOCK_RETRY_MS = 25;
const RELEASE_INVITE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function inviteKey(token: string) {
  return `${INVITE_PREFIX}:${token}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class InviteLockTimeoutError extends Error {
  override name = "InviteLockTimeoutError";
}

async function withInviteLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const lockKey = `${INVITE_PREFIX}:accept-lock:${tokenHash}`;
  const lockToken = randomUUID();
  const deadline = Date.now() + INVITE_LOCK_WAIT_MS;

  while (true) {
    const acquired = await redisCommandClient.set(
      lockKey,
      lockToken,
      "PX",
      INVITE_LOCK_TTL_MS,
      "NX",
    );
    if (acquired === "OK") break;
    if (Date.now() >= deadline) throw new InviteLockTimeoutError("invitation is busy");
    await sleep(INVITE_LOCK_RETRY_MS);
  }

  try {
    return await fn();
  } finally {
    await redisCommandClient.eval(
      RELEASE_INVITE_LOCK_SCRIPT,
      1,
      lockKey,
      lockToken,
    ).catch((error) => {
      logger.warn("[Invite] failed to release accept lock", { lockKey, error });
    });
  }
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

  const token = c.req.param("token");
  const key = inviteKey(token);
  let accepted: Response | { spaceId: string; role: SpaceRole };
  try {
    accepted = await withInviteLock(token, async () => {
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
      const role = data.role as SpaceRole | undefined;
      if (!spaceId || !role) {
        return c.json({ message: "invitation expired or not found" }, 410);
      }

      // Invite links may upgrade an existing lower-role member, but never demote.
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
          spaceId,
          userId: user.uuid,
          role,
          createdBy: user.uuid,
          updatedBy: user.uuid,
        });
        consumedInviteUse = true;
      }

      if (consumedInviteUse) {
        const newCount = await redisCommandClient.hincrby(key, "use_count", 1);
        if (maxUses > 0 && newCount >= maxUses) {
          await redisCommandClient.hset(key, "status", "exhausted");
        }
      }

      return { spaceId, role: acceptedRole };
    });
  } catch (error) {
    if (error instanceof InviteLockTimeoutError) {
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
