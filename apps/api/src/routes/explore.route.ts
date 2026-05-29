import { createLogger } from "@cohub/infra/logging";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createCachedExploreConfig,
  EXPLORE_CACHE_TTL_SEC,
  parseCachedExploreConfig,
  parseExploreConfig,
  PLATFORM_EXPLORE_REDIS_KEY,
  type CachedExploreConfig,
  type ExploreConfig,
  type ExploreSectionConfig,
  type ExploreSpaceConfig,
} from "@cohub/infra/config-runtime";
import { accessPolicies, checkpoints, spaces } from "@cohub/db";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { redisCommandClient } from "../redis.js";
import { getSpacePublicProfile } from "../lib/middleware.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });
const PLATFORM_EXPLORE_PATH = join(config.platformConfigRoot, "platform", ".cohub", "explore.json");
const inflightByKey = new Map<string, Promise<ExploreConfig | null>>();

type ExploreSpaceItem = {
  id: string;
  slug: string | null;
  title: string;
  summary: string | null;
  spaceUrl: string;
  coverUrl: string | null;
  coverAlt: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  category: string | null;
  tags: string[];
  skillCount: number;
  assetCount: number;
  forkCount: number;
  updatedAt: string | null;
  accessLabel: "public" | "sign-in-required" | "unknown";
  latestSignal: string | null;
};

type ExploreSectionResult = {
  key: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  spaces: ExploreSpaceItem[];
};

function normalizeSection(
  section: ExploreSectionConfig | null | undefined,
  fallbackKey: string,
): ExploreSectionConfig | null {
  if (!section) return null;
  return {
    key: section.key || fallbackKey,
    title: section.title,
    subtitle: section.subtitle,
    description: section.description,
    spaces: [...section.spaces],
  };
}

function normalizeExploreConfig(config: ExploreConfig | null): ExploreSectionConfig[] {
  if (!config) return [];
  const sections = [...(config.sections ?? [])]
    .map((section, index) => normalizeSection(section, `section-${index + 1}`))
    .filter((section): section is ExploreSectionConfig => Boolean(section));
  if (sections.length > 0) return sections;
  if ((config.spaces ?? []).length === 0) return [];
  return [{
    key: "featured",
    title: undefined,
    subtitle: undefined,
    description: undefined,
    spaces: [...(config.spaces ?? [])],
  }];
}

function dedupeSpaces(sections: ExploreSectionConfig[]) {
  const seen = new Set<string>();
  const ordered: ExploreSpaceConfig[] = [];
  for (const section of sections) {
    const sectionSpaces = [...section.spaces]
      .filter((item) => item.spaceId)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    for (const entry of sectionSpaces) {
      if (seen.has(entry.spaceId)) continue;
      seen.add(entry.spaceId);
      ordered.push(entry);
    }
  }
  return ordered;
}

const ALLOWED_COVER_HOSTS = new Set([
  "cohub.run",
  "dev.cohub.run",
  "api.cohub.run",
  "api-dev.cohub.run",
  "public.cohub.run",
  "sessions.cohub.run",
  "localhost",
  "127.0.0.1",
]);

function normalizeExploreCoverUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!ALLOWED_COVER_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function loadExploreFromFile(input: {
  explorePath: string;
  redisKey: string;
  allowMissing: boolean;
}): Promise<CachedExploreConfig> {
  let rawText: string;
  try {
    rawText = await readFile(input.explorePath, "utf-8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT" && input.allowMissing) {
      const cached = createCachedExploreConfig({ content: null });
      await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", EXPLORE_CACHE_TTL_SEC);
      return cached;
    }
    if (code === "ENOENT") throw new Error("Explore config file not found");
    throw error;
  }

  let content: ExploreConfig;
  try {
    content = parseExploreConfig(rawText);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Explore config file is invalid JSON");
    throw error;
  }

  const cached = createCachedExploreConfig({ rawText, content });
  await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", EXPLORE_CACHE_TTL_SEC);
  return cached;
}

async function loadCachedExplore(input: {
  redisKey: string;
  explorePath: string;
  allowMissing: boolean;
}): Promise<ExploreConfig | null> {
  const inflight = inflightByKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey);
    if (cached) {
      try {
        const parsed = parseCachedExploreConfig(cached);
        if (parsed) return parsed.content;
      } catch {
        // fall back to file
      }
    }
    return (await loadExploreFromFile(input)).content;
  })();

  inflightByKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByKey.delete(input.redisKey);
  }
}

const router = new Hono();

router.get("/spaces", async (c) => {
  try {
    const exploreConfig = await loadCachedExplore({
      redisKey: PLATFORM_EXPLORE_REDIS_KEY,
      explorePath: PLATFORM_EXPLORE_PATH,
      allowMissing: true,
    });
    const sections = normalizeExploreConfig(exploreConfig);
    if (sections.length === 0) return c.json({ sections: [], spaces: [] });

    const configuredSpaces = dedupeSpaces(sections);
    if (configuredSpaces.length === 0) return c.json({ sections: [], spaces: [] });

    const spaceIds = [...new Set(configuredSpaces.map((item) => item.spaceId))];
    const [spaceRows, policyRows] = await Promise.all([
      db.select().from(spaces).where(inArray(spaces.id, spaceIds)),
      db.select().from(accessPolicies).where(and(
        eq(accessPolicies.resourceType, "space"),
        inArray(accessPolicies.resourceId, spaceIds),
      )),
    ]);

    const spacesById = new Map(spaceRows.map((space) => [space.id, space]));
    const policyBySpaceId = new Map(policyRows.map((policy) => [policy.resourceId, policy]));
    const visibleIds = configuredSpaces
      .map((item) => item.spaceId)
      .filter((spaceId) => {
        const policy = policyBySpaceId.get(spaceId);
        return policy?.anonymousUserRole === "guest" ||
          policy?.signedInUserRole === "guest" ||
          policy?.signedInUserRole === "builder";
      });

    const [checkpointRows, checkpointStats, pinCounts] = await Promise.all([
      visibleIds.length > 0
        ? db.execute(sql`
          select *
          from (
            select
              c.*,
              row_number() over (partition by c.space_id order by c.created_at desc) as rn
            from v2.checkpoints c
            where c.space_id in (${sql.join(visibleIds, sql`, `)})
          ) ranked
          where ranked.rn <= 3
          order by ranked.space_id, ranked.created_at desc
        `) as Promise<Array<typeof checkpoints.$inferSelect & { rn: number }>>
        : Promise.resolve([]),
      visibleIds.length > 0
        ? db
            .select({
              spaceId: checkpoints.spaceId,
              checkpointCount: sql<number>`count(*)::int`,
              forkCount: sql<number>`coalesce(sum(${checkpoints.forkCount}), 0)::int`,
            })
            .from(checkpoints)
            .where(inArray(checkpoints.spaceId, visibleIds))
            .groupBy(checkpoints.spaceId)
        : Promise.resolve([] as Array<{ spaceId: string; checkpointCount: number; forkCount: number }>),
      visibleIds.length > 0
        ? db.execute(sql`
          select m.space_id as "spaceId", count(*)::int as count
          from v2.space_marks m
          where m.kind = 'pin'
            and m.space_id in (${sql.join(visibleIds, sql`, `)})
            and (
              (m.resource_type = 'file')
              or (m.resource_type = 'session' and exists (
                select 1 from v2.space_sessions s where s.space_id = m.space_id and s.id::text = m.resource_ref
              ))
              or (m.resource_type = 'checkpoint' and exists (
                select 1 from v2.checkpoints c where c.space_id = m.space_id and c.id::text = m.resource_ref
              ))
            )
          group by m.space_id
        `) as Promise<Array<{ spaceId: string; count: number }>>
        : Promise.resolve([]),
    ]);

    const checkpointStatsBySpaceId = new Map(checkpointStats.map((row) => [row.spaceId, row]));
    const pinCountBySpaceId = new Map(pinCounts.map((row) => [row.spaceId, Number(row.count)]));
    const checkpointsBySpaceId = new Map<string, Array<typeof checkpoints.$inferSelect>>();
    for (const checkpoint of checkpointRows) {
      const list = checkpointsBySpaceId.get(checkpoint.spaceId) ?? [];
      list.push(checkpoint);
      checkpointsBySpaceId.set(checkpoint.spaceId, list);
    }

    const profileByUserUuid = await getProfilesByUuids(spaceRows.map((space) => space.userUuid));

    const buildItem = (spaceId: string, entry: ExploreSpaceConfig): ExploreSpaceItem | null => {
      const space = spacesById.get(spaceId);
      const policy = policyBySpaceId.get(spaceId);
      if (!space || !policy) return null;
      const ownerProfile = profileByUserUuid.get(space.userUuid) ?? fallbackPublicUserProfile(space.userUuid);
      const latestCheckpoint = checkpointsBySpaceId.get(space.id)?.[0] ?? null;
      const stats = checkpointStatsBySpaceId.get(space.id);
      const publicProfile = getSpacePublicProfile(space);
      const title = space.name || space.id;
      return {
        id: space.id,
        slug: space.slug ?? null,
        title,
        summary: space.description ?? null,
        spaceUrl: `/spaces/${space.id}`,
        coverUrl: normalizeExploreCoverUrl(publicProfile.avatarUrl),
        coverAlt: publicProfile.avatarUrl ? `${title} cover` : null,
        ownerDisplayName: ownerProfile?.displayName ?? null,
        ownerAvatarUrl: normalizeExploreCoverUrl(ownerProfile?.avatarUrl ?? null),
        category: entry.label ?? entry.category ?? null,
        tags: [entry.category, entry.label].filter((v): v is string => Boolean(v)),
        skillCount: stats?.checkpointCount ?? 0,
        assetCount: pinCountBySpaceId.get(space.id) ?? 0,
        forkCount: stats?.forkCount ?? 0,
        updatedAt: space.updatedAt ? new Date(space.updatedAt).toISOString() : null,
        accessLabel: policy.anonymousUserRole ? "public" : "sign-in-required",
        latestSignal: latestCheckpoint ? latestCheckpoint.description || latestCheckpoint.commitHash.slice(0, 12) : null,
      };
    };

    const sectionsResult: ExploreSectionResult[] = sections.map((section) => ({
      key: section.key,
      title: section.title ?? null,
      subtitle: section.subtitle ?? null,
      description: section.description ?? null,
      spaces: section.spaces
        .map((entry) => buildItem(entry.spaceId, entry))
        .filter((item): item is ExploreSpaceItem => Boolean(item)),
    }));

    const spacesResult = configuredSpaces
      .map((entry) => buildItem(entry.spaceId, entry))
      .filter((item): item is ExploreSpaceItem => Boolean(item));

    return c.json({ sections: sectionsResult, spaces: spacesResult });
  } catch (error) {
    logger.error("[explore] failed to load spaces", error);
    return c.json({ message: "failed to load explore spaces" }, 502);
  }
});

export default router;
