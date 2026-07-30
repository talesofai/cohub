import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq, gte, lte, desc } from "drizzle-orm";
import * as schema from "@cohub/db";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { requireValidId, useAuth, authzDenied } from "../lib/middleware.js";
import { ensureCurrentUserProfile, resolveCurrentUserEmail, updateCurrentUserProfile, LogtoUserRequiredError, UsernameClearError, UsernameConflictError, UsernameReservedError, validateUsername } from "../user-profiles.js";
import {
  filterSessionsByPermission,
  getSpaceMemberRole,
  hasPermission,
  asAccountIdentity,
} from "../permissions.js";
import { pickSessionsPreservingOrder } from "../session-list.js";
import {
  attachSessionSpaceSummaries,
  encodeSessionListCursor,
  hydrateSessionParticipantProfiles,
  InvalidSessionListCursorError,
  listUserSessions,
} from "../space-sessions.js";
import {
  aggregateGenerationUsageRows,
  aggregateUsageRows,
  buildUsageDateRange,
  GENERATION_USAGE_SELECT_COLUMNS,
  resolveUsageDays,
  USAGE_SELECT_COLUMNS,
  type GenerationUsageRow,
  type UsageRow,
} from "../usage-aggregation.js";
import { createLogger } from "@cohub/infra/logging";
import { getReferralDashboard, rotateReferralCode } from "../referrals.js";

const logger = createLogger({ serviceName: "cohub-api" });

const USER_RULES_FILE_NAME = "AGENTS.md";
const USER_RULES_SANDBOX_PATH = "/configs/user/AGENTS.md";

const router = new Hono();

function getUserRulesPath(userId: string) {
  return join(config.platformConfigRoot, "users", userId, USER_RULES_FILE_NAME);
}

function assertValidUserId(userId: string) {
  if (!requireValidId(userId)) {
    throw new Error("invalid user id");
  }
}

function getErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readUserRules(userId: string) {
  assertValidUserId(userId);
  const path = getUserRulesPath(userId);
  try {
    const [content, fileStat] = await Promise.all([
      readFile(path, "utf-8"),
      stat(path),
    ]);
    return {
      content,
      updatedAt: fileStat.mtime.toISOString(),
      source: "config-space" as const,
      path: USER_RULES_SANDBOX_PATH,
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        content: "",
        updatedAt: null,
        source: "config-space" as const,
        path: USER_RULES_SANDBOX_PATH,
      };
    }
    throw error;
  }
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const profile = await ensureCurrentUserProfile(user);
  const email = await resolveCurrentUserEmail(user);
  return c.json({ uuid: user.uuid, profile, email });
});

router.patch("/profile", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ displayName?: unknown; avatarUrl?: unknown; username?: unknown }>().catch(() => ({} as { displayName?: unknown; avatarUrl?: unknown; username?: unknown }));
  const input: { displayName?: string; avatarUrl?: string | null; username?: string | null } = {};

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") return c.json({ message: "displayName must be a string" }, 400);
    const displayName = body.displayName.replace(/\s+/g, " ").trim();
    if (displayName.length < 1 || displayName.length > 120) {
      return c.json({ message: "displayName must be 1-120 characters" }, 400);
    }
    input.displayName = displayName;
  }

  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null || body.avatarUrl === "") {
      input.avatarUrl = null;
    } else if (typeof body.avatarUrl === "string") {
      const avatarUrl = body.avatarUrl.trim();
      try {
        const url = new URL(avatarUrl);
        if (url.protocol !== "https:") return c.json({ message: "avatarUrl must be an https URL" }, 400);
      } catch {
        return c.json({ message: "avatarUrl must be a valid URL" }, 400);
      }
      input.avatarUrl = avatarUrl;
    } else {
      return c.json({ message: "avatarUrl must be a string or null" }, 400);
    }
  }

  if (body.username !== undefined) {
    if (body.username === null || body.username === "") {
      input.username = null;
    } else if (typeof body.username === "string") {
      const { username, error } = validateUsername(body.username);
      if (error) return c.json({ message: error }, 400);
      input.username = username;
    } else {
      return c.json({ message: "username must be a string or null" }, 400);
    }
  }
  if (input.displayName === undefined && input.avatarUrl === undefined && input.username === undefined) {
    return c.json({ message: "displayName, avatarUrl, or username is required" }, 400);
  }

  try {
    const profile = await updateCurrentUserProfile(user, input);
    return c.json({ profile });
  } catch (error) {
    if (error instanceof UsernameConflictError) {
      return c.json({ message: error.message }, 409);
    }
    if (error instanceof UsernameClearError) {
      return c.json({ message: error.message }, 400);
    }
    if (error instanceof UsernameReservedError) {
      return c.json({
        code: "public_identifier_reserved",
        field: "username",
        message: error.message,
      }, 400);
    }
    if (error instanceof LogtoUserRequiredError) {
      return c.json({ message: error.message }, 403);
    }
    throw error;
  }
});

router.get("/referrals", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  return c.json(await getReferralDashboard(user.uuid));
});

router.post("/referrals/code/rotate", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const code = await rotateReferralCode(user.uuid);
  return c.json({ code: code.code });
});

router.get("/rules", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    return c.json(await readUserRules(user.uuid));
  } catch {
    return c.json({ message: "failed to load user rules" }, 500);
  }
});

/**
 * Cross-space recent sessions for the account identity.
 * Gate: `user.session.list`. Visibility: viewer's own membership / access policy
 * (not work-scoped session.view). Over-fetches after filtering for pagination.
 */
async function listVisibleUserSessions(
  user: { uuid: string },
  options: { limit: number; cursor: string | null },
) {
  const identity = asAccountIdentity(user);
  if (!identity) {
    return { sessions: [], pageInfo: { hasMore: false, nextCursor: null } };
  }

  const limit = options.limit;
  const visible: Awaited<ReturnType<typeof listUserSessions>>["sessions"] = [];
  let cursor = options.cursor;
  let hasMore = true;
  let guard = 0;

  // Cache space membership + space-level view for this request.
  const memberViewBySpace = new Map<string, boolean>();

  const canViewAllInSpace = async (spaceId: string) => {
    const cached = memberViewBySpace.get(spaceId);
    if (cached !== undefined) return cached;
    const isMember = (await getSpaceMemberRole(spaceId, identity.uuid)) !== null;
    const allowed = isMember
      ? await hasPermission(identity, "session.view", { spaceId })
      : false;
    memberViewBySpace.set(spaceId, allowed);
    return allowed;
  };

  while (visible.length < limit && hasMore && guard < 8) {
    guard += 1;
    const batchLimit = Math.min(100, Math.max(limit * 2, limit - visible.length + 4));
    const batch = await listUserSessions(identity.uuid, { limit: batchLimit, cursor });
    hasMore = Boolean(batch.pageInfo.hasMore);
    cursor = batch.pageInfo.nextCursor;

    if (batch.sessions.length === 0) break;

    // Group by space only for permission checks. Re-emit in batch activity order
    // so cross-space recency is not scrambled by Map iteration / space buckets.
    const bySpace = new Map<string, typeof batch.sessions>();
    for (const session of batch.sessions) {
      const list = bySpace.get(session.spaceId) ?? [];
      list.push(session);
      bySpace.set(session.spaceId, list);
    }

    const visibleIds = new Set<string>();
    for (const [spaceId, sessions] of bySpace) {
      if (await canViewAllInSpace(spaceId)) {
        for (const session of sessions) visibleIds.add(session.id);
        continue;
      }
      const filtered = await filterSessionsByPermission(
        identity,
        "session.view",
        spaceId,
        sessions,
      );
      for (const session of filtered) visibleIds.add(session.id);
    }
    visible.push(...pickSessionsPreservingOrder(batch.sessions, visibleIds));

    if (!hasMore) break;
  }

  const sessions = visible.slice(0, limit);
  // Prefer the last returned visible row so the client continues past filtered gaps.
  // If we still have more raw pages but returned nothing visible, advance with the raw cursor.
  const lastVisible = sessions.at(-1);
  const nextCursor = sessions.length === 0
    ? (hasMore ? cursor : null)
    : (visible.length > limit || hasMore
      ? encodeSessionListCursor(lastVisible)
      : null);

  return {
    sessions,
    pageInfo: {
      hasMore: Boolean(nextCursor),
      nextCursor,
    },
  };
}

router.get("/sessions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.session.list", { spaceId: "" }))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;
  const cursor = c.req.query("cursor") ?? null;
  try {
    const { sessions, pageInfo } = await listVisibleUserSessions(user, { limit, cursor });
    const hydratedSessions = await hydrateSessionParticipantProfiles(sessions);
    const withSpaces = await attachSessionSpaceSummaries(hydratedSessions);
    return c.json({ sessions: withSpaces, pageInfo });
  } catch (error) {
    if (error instanceof InvalidSessionListCursorError) {
      return c.json({ message: "invalid cursor" }, 400);
    }
    logger.error("[me/sessions] query failed", error);
    return c.json({ message: "failed to load sessions" }, 500);
  }
});

router.get("/usage", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.usage.read", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  const days = resolveUsageDays(c.req.query("days"));
  const { startDate, now } = buildUsageDateRange(days);

  let rows: UsageRow[];
  let generationRows: GenerationUsageRow[];
  try {
    [rows, generationRows] = await Promise.all([
      db
        .select(USAGE_SELECT_COLUMNS)
        .from(schema.tokenUsageStatsHourly)
        .where(
          and(
            eq(schema.tokenUsageStatsHourly.userId, identity.uuid),
            gte(schema.tokenUsageStatsHourly.bucketStartAt, startDate),
            lte(schema.tokenUsageStatsHourly.bucketStartAt, now),
          ),
        )
        .orderBy(desc(schema.tokenUsageStatsHourly.bucketStartAt)),
      db
        .select(GENERATION_USAGE_SELECT_COLUMNS)
        .from(schema.generationUsageStatsHourly)
        .where(
          and(
            eq(schema.generationUsageStatsHourly.userId, identity.uuid),
            gte(schema.generationUsageStatsHourly.bucketStartAt, startDate),
            lte(schema.generationUsageStatsHourly.bucketStartAt, now),
          ),
        )
        .orderBy(desc(schema.generationUsageStatsHourly.bucketStartAt)),
    ]);
  } catch (error) {
    logger.error("[me/usage] DB query failed", error);
    return c.json({ message: "failed to load usage data" }, 500);
  }

  const { hourly, summary } = aggregateUsageRows(rows);
  const generation = aggregateGenerationUsageRows(generationRows);
  return c.json({ hourly, summary, generation, days });
});

export default router;
