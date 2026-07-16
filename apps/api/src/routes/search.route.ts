import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";
import { normalizePublicAvatarUrl, useAuth } from "../lib/middleware.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();
const MIN_QUERY_LENGTH = 2;
const MIN_GLOBAL_TURN_QUERY_LENGTH = 3;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SEARCH_RESOURCE_TYPES = ["turn", "session", "space", "label"] as const;
const SEARCH_RESOURCE_TYPE_SET = new Set<string>(SEARCH_RESOURCE_TYPES);

type SearchResourceType = (typeof SEARCH_RESOURCE_TYPES)[number];
type SearchMatchedField = "userText" | "title" | "name" | "description" | "labelName" | "labelItemContent";

type SearchResultRow = {
  type: SearchResourceType;
  id: string;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  sequence: number | null;
  title: string;
  excerpt: string | null;
  spaceName: string | null;
  ownerUserUuid: string | null;
  spaceProfile: { avatarUrl: string | null } | null;
  sessionTitle: string | null;
  matchedField: SearchMatchedField;
  updatedAt: Date | string | null;
  textScore: number;
  recencyScore: number;
  typePriorityScore: number;
  membershipPriorityScore: number;
  labelRef: string | null;
  labelName: string | null;
  labelResourceType: string | null;
  labelResourceRef: string | null;
  score: number;
};

function clampLimit(value: string | undefined) {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function normalizeQuery(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function hasInformativeQuery(value: string) {
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizeLabelRef(value: string | undefined) {
  return (value ?? "")
    .split("/")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("/");
}

function parseSearchTypes(typeValues: string[] | undefined, typesValue: string | undefined) {
  const rawTypes = [...(typeValues ?? []), typesValue ?? ""]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const invalidTypes = rawTypes.filter((type) => !SEARCH_RESOURCE_TYPE_SET.has(type));
  if (invalidTypes.length > 0) return { error: `invalid search type: ${invalidTypes[0]}` } as const;
  return {
    explicitTypes: rawTypes.length > 0,
    types: new Set<SearchResourceType>(
      rawTypes.length > 0 ? (rawTypes as SearchResourceType[]) : SEARCH_RESOURCE_TYPES,
    ),
  } as const;
}

function parseSpaceId(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return { spaceId: null } as const;
  if (!UUID_PATTERN.test(normalized)) return { error: "invalid spaceId" } as const;
  return { spaceId: normalized } as const;
}

function toIso(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function hrefFor(row: SearchResultRow) {
  if (row.type === "space") return `/spaces/${row.spaceId}`;
  if (row.type === "session") return `/spaces/${row.spaceId}/sessions/${row.sessionId}`;
  if (row.type === "label") {
    if (row.labelResourceType === "session") return `/spaces/${row.spaceId}/sessions/${row.labelResourceRef}`;
    if (row.labelResourceType === "checkpoint") return `/spaces/${row.spaceId}/checkpoints/${row.labelResourceRef}`;
    if (row.labelResourceType === "file") return `/spaces/${row.spaceId}/files/${(row.labelResourceRef ?? "").split("/").map(encodeURIComponent).join("/")}`;
    return `/spaces/${row.spaceId}`;
  }
  return `/spaces/${row.spaceId}/sessions/${row.sessionId}?turn=${row.sequence}`;
}

function mapRow(row: SearchResultRow, profiles?: Awaited<ReturnType<typeof getProfilesByUuids>>) {
  const ownerProfile = row.ownerUserUuid
    ? (profiles?.get(row.ownerUserUuid) ?? fallbackPublicUserProfile(row.ownerUserUuid))
    : null;
  const spaceProfile = {
    avatarUrl: normalizePublicAvatarUrl(row.spaceProfile?.avatarUrl),
  };
  return {
    type: row.type,
    id: row.id,
    spaceId: row.spaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    sequence: row.sequence,
    title: row.title,
    excerpt: row.excerpt,
    spaceName: row.spaceName,
    ownerProfile: row.type === "space" ? ownerProfile : null,
    spaceProfile,
    sessionTitle: row.sessionTitle,
    matchedField: row.matchedField,
    href: hrefFor(row),
    score: Number(row.score ?? 0),
    textScore: Number(row.textScore ?? 0),
    recencyScore: Number(row.recencyScore ?? 0),
    typePriorityScore: Number(row.typePriorityScore ?? 0),
    membershipPriorityScore: Number(row.membershipPriorityScore ?? 0),
    labelRef: row.labelRef,
    labelName: row.labelName,
    labelResourceType: row.labelResourceType,
    labelResourceRef: row.labelResourceRef,
    updatedAt: toIso(row.updatedAt),
    source: "remote" as const,
  };
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const q = normalizeQuery(c.req.query("q"));
  const escapedQ = escapeLikePattern(q);
  const limit = clampLimit(c.req.query("limit"));
  const parsedTypes = parseSearchTypes(c.req.queries("type"), c.req.query("types"));
  if ("error" in parsedTypes) return c.json({ message: parsedTypes.error }, 400);
  const labelRef = normalizeLabelRef(c.req.query("labelRef"));
  const parsedSpaceId = parseSpaceId(c.req.query("spaceId"));
  if ("error" in parsedSpaceId) return c.json({ message: parsedSpaceId.error }, 400);
  const spaceId = parsedSpaceId.spaceId;
  const includeTurns =
    parsedTypes.types.has("turn") &&
    (parsedTypes.explicitTypes || spaceId !== null || q.length >= MIN_GLOBAL_TURN_QUERY_LENGTH);
  const includeSessions = parsedTypes.types.has("session");
  const includeSpaces = parsedTypes.types.has("space");
  const includeLabels = parsedTypes.types.has("label") && labelRef !== "";

  if ((!includeLabels || !labelRef) && (q.length < MIN_QUERY_LENGTH || !hasInformativeQuery(q))) {
    return c.json({ items: [], query: q, source: "remote" });
  }

  const resultQueries = [
    ...(includeTurns ? [sql`SELECT * FROM turn_results`] : []),
    ...(includeSessions ? [sql`SELECT * FROM session_results`] : []),
    ...(includeSpaces ? [sql`SELECT * FROM space_results`] : []),
    ...(includeLabels ? [sql`SELECT * FROM label_results`] : []),
  ];
  if (resultQueries.length === 0) {
    return c.json({ items: [], query: q, source: "remote" });
  }
  const combinedResults = sql.join(resultQueries, sql`
      UNION ALL
      `);

  try {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = 0.2`);
      return tx.execute<SearchResultRow>(sql`
    WITH visible_spaces AS MATERIALIZED (
      SELECT
        s.*,
        CASE
          WHEN s.user_uuid = ${user.uuid} OR sm.user_id IS NOT NULL THEN 1.0::double precision
          ELSE 0.0::double precision
        END AS membership_priority_score
      FROM v2.spaces s
      LEFT JOIN v2.space_members sm
        ON sm.space_id = s.id AND sm.user_id = ${user.uuid}
      WHERE
        (${spaceId}::uuid IS NULL OR s.id = ${spaceId}::uuid)
        AND (
          s.user_uuid = ${user.uuid}
          OR sm.user_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM v2.space_access_policies ap
            WHERE ap.space_id = s.id
              AND (ap.signed_in_user_role IS NOT NULL OR ap.anonymous_user_role IS NOT NULL)
          )
        )
    ),
    visible_sessions AS NOT MATERIALIZED (
      SELECT
        sess.*,
        sp.name AS space_name,
        sp.user_uuid AS owner_user_uuid,
        jsonb_build_object('avatarUrl', nullif(trim(coalesce(sp.meta #>> '{publicProfile,avatarUrl}', '')), '')) AS space_profile,
        sp.membership_priority_score
      FROM v2.space_sessions sess
      JOIN visible_spaces sp ON sp.id = sess.space_id
    ),
    space_results AS (
      SELECT
        'space'::text AS type,
        s.id AS id,
        s.id AS space_id,
        NULL::uuid AS session_id,
        NULL::uuid AS turn_id,
        NULL::int AS sequence,
        s.name AS title,
        CASE
          WHEN coalesce(s.description, '') = '' THEN NULL::text
          ELSE left(regexp_replace(s.description, '\\s+', ' ', 'g'), 220)
        END AS excerpt,
        s.name AS space_name,
        s.user_uuid AS owner_user_uuid,
        jsonb_build_object('avatarUrl', nullif(trim(coalesce(s.meta #>> '{publicProfile,avatarUrl}', '')), '')) AS space_profile,
        NULL::text AS session_title,
        CASE
          WHEN scores.name_text_score >= scores.description_text_score THEN 'name'::text
          ELSE 'description'::text
        END AS matched_field,
        coalesce(s.last_activity_at, s.updated_at, s.created_at) AS updated_at,
        GREATEST(scores.name_text_score, scores.description_text_score) AS text_score,
        1.00::double precision AS type_priority_score,
        s.membership_priority_score AS membership_priority_score,
        NULL::text AS label_ref,
        NULL::text AS label_name,
        NULL::text AS label_resource_type,
        NULL::text AS label_resource_ref
      FROM visible_spaces s
      CROSS JOIN LATERAL (
        SELECT
          CASE
            WHEN lower(s.name) = lower(${q}) THEN 1.00
            WHEN lower(s.name) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.92
            WHEN s.name ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
            ELSE similarity(s.name, ${q}) * 0.70
          END * 0.90 AS name_text_score,
          CASE
            WHEN lower(coalesce(s.description, '')) = lower(${q}) THEN 1.00
            WHEN lower(coalesce(s.description, '')) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.88
            WHEN coalesce(s.description, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.68
            ELSE similarity(coalesce(s.description, ''), ${q}) * 0.58
          END * 0.68 AS description_text_score
      ) scores
      WHERE
        ${includeSpaces}
        AND (
          s.name ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR s.description ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR s.name % ${q}
          OR s.description % ${q}
        )
    ),
    session_results AS (
      SELECT
        'session'::text AS type,
        sess.id AS id,
        sess.space_id AS space_id,
        sess.id AS session_id,
        NULL::uuid AS turn_id,
        NULL::int AS sequence,
        coalesce(nullif(sess.title, ''), 'Untitled session') AS title,
        NULL::text AS excerpt,
        sess.space_name AS space_name,
        sess.owner_user_uuid AS owner_user_uuid,
        sess.space_profile AS space_profile,
        sess.title AS session_title,
        'title'::text AS matched_field,
        coalesce(sess.last_message_at, sess.updated_at, sess.created_at) AS updated_at,
        CASE
          WHEN lower(coalesce(sess.title, '')) = lower(${q}) THEN 1.00
          WHEN lower(coalesce(sess.title, '')) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.92
          WHEN coalesce(sess.title, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
          ELSE similarity(coalesce(sess.title, ''), ${q}) * 0.70
        END * 0.94 AS text_score,
        0.74::double precision AS type_priority_score,
        sess.membership_priority_score AS membership_priority_score,
        NULL::text AS label_ref,
        NULL::text AS label_name,
        NULL::text AS label_resource_type,
        NULL::text AS label_resource_ref
      FROM visible_sessions sess
      WHERE
        ${includeSessions}
        AND (
          sess.title ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR sess.title % ${q}
        )
    ),
    turn_results AS (
      SELECT
        'turn'::text AS type,
        t.id AS id,
        sess.space_id AS space_id,
        sess.id AS session_id,
        t.id AS turn_id,
        t.sequence AS sequence,
        left(regexp_replace(coalesce(t.user_text, ''), '\\s+', ' ', 'g'), 140) AS title,
        left(regexp_replace(coalesce(t.user_text, ''), '\\s+', ' ', 'g'), 260) AS excerpt,
        sess.space_name AS space_name,
        sess.owner_user_uuid AS owner_user_uuid,
        sess.space_profile AS space_profile,
        sess.title AS session_title,
        'userText'::text AS matched_field,
        coalesce(t.updated_at, t.created_at) AS updated_at,
        CASE
          WHEN lower(t.user_text) = lower(${q}) THEN 1.00
          WHEN lower(t.user_text) LIKE lower(${escapedQ}) || '%' ESCAPE '\\' THEN 0.92
          WHEN t.user_text ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
          ELSE similarity(t.user_text, ${q}) * 0.70
        END AS text_score,
        0.66::double precision AS type_priority_score,
        sess.membership_priority_score AS membership_priority_score,
        NULL::text AS label_ref,
        NULL::text AS label_name,
        NULL::text AS label_resource_type,
        NULL::text AS label_resource_ref
      FROM v2.session_turns t
      JOIN visible_sessions sess ON sess.id = t.session_id
      WHERE
        ${includeTurns}
        AND t.user_text IS NOT NULL
        AND t.user_text ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
    ),
    label_matches AS (
      SELECT
        l.*,
        sp.name AS space_name,
        sp.user_uuid AS owner_user_uuid,
        jsonb_build_object('avatarUrl', nullif(trim(coalesce(sp.meta #>> '{publicProfile,avatarUrl}', '')), '')) AS space_profile,
        sp.membership_priority_score,
        CASE
          WHEN parent.id IS NULL THEN l.name
          ELSE parent.name || '/' || l.name
        END AS label_ref
      FROM v2.labels l
      JOIN visible_spaces sp ON sp.id = l.space_id
      LEFT JOIN v2.labels parent
        ON parent.id = l.parent_id AND parent.space_id = l.space_id
      WHERE
        ${includeLabels}
        AND ${labelRef} <> ''
        AND (
          lower(CASE WHEN parent.id IS NULL THEN l.name ELSE parent.name || '/' || l.name END) = lower(${labelRef})
          OR lower(l.name) = lower(${labelRef})
        )
    ),
    label_results AS (
      SELECT
        'label'::text AS type,
        la.id AS id,
        lm.space_id AS space_id,
        la.session_id AS session_id,
        NULL::uuid AS turn_id,
        NULL::int AS sequence,
        CASE
          WHEN la.resource_type = 'session' THEN coalesce(nullif(sess.title, ''), sess.latest_message_text, 'New chat')
          WHEN la.resource_type = 'checkpoint' THEN coalesce(nullif(cp.description, ''), left(cp.commit_hash, 12))
          WHEN la.resource_type = 'file' THEN coalesce(nullif(split_part(la.resource_ref, '/', array_length(string_to_array(la.resource_ref, '/'), 1)), ''), la.resource_ref)
          ELSE la.resource_ref
        END AS title,
        CASE
          WHEN la.resource_type = 'session' THEN left(regexp_replace(coalesce(sess.latest_message_text, ''), '\\s+', ' ', 'g'), 260)
          WHEN la.resource_type = 'checkpoint' THEN cp.commit_hash
          WHEN la.resource_type = 'file' THEN la.resource_ref
          ELSE NULL::text
        END AS excerpt,
        lm.space_name AS space_name,
        lm.owner_user_uuid AS owner_user_uuid,
        lm.space_profile AS space_profile,
        sess.title AS session_title,
        CASE WHEN ${q} = '' THEN 'labelName'::text ELSE 'labelItemContent'::text END AS matched_field,
        coalesce(sess.last_message_at, sess.updated_at, cp.created_at, la.updated_at, la.created_at) AS updated_at,
        CASE
          WHEN ${q} = '' THEN 1.00
          WHEN lower(coalesce(sess.title, '')) = lower(${q}) THEN 1.00
          WHEN lower(coalesce(sess.latest_message_text, '')) = lower(${q}) THEN 0.96
          WHEN lower(coalesce(cp.description, '')) = lower(${q}) THEN 0.94
          WHEN lower(la.resource_ref) = lower(${q}) THEN 0.92
          WHEN coalesce(sess.title, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.78
          WHEN coalesce(sess.latest_message_text, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
          WHEN coalesce(cp.description, '') ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.74
          WHEN la.resource_ref ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\' THEN 0.72
          ELSE GREATEST(
            similarity(coalesce(sess.title, ''), ${q}) * 0.72,
            similarity(coalesce(sess.latest_message_text, ''), ${q}) * 0.66,
            similarity(coalesce(cp.description, ''), ${q}) * 0.66,
            similarity(la.resource_ref, ${q}) * 0.64
          )
        END AS text_score,
        0.72::double precision AS type_priority_score,
        lm.membership_priority_score AS membership_priority_score,
        lm.label_ref AS label_ref,
        lm.name AS label_name,
        la.resource_type AS label_resource_type,
        la.resource_ref AS label_resource_ref
      FROM label_matches lm
      JOIN v2.label_assignments la
        ON la.label_id = lm.id AND la.space_id = lm.space_id
      LEFT JOIN visible_sessions sess
        ON sess.id = la.session_id
      LEFT JOIN v2.checkpoints cp
        ON cp.space_id = lm.space_id AND cp.id = la.checkpoint_id
      WHERE
        ${includeLabels}
        AND (
          (la.resource_type = 'session' AND sess.id IS NOT NULL)
          OR (la.resource_type = 'checkpoint' AND cp.id IS NOT NULL)
          OR la.resource_type = 'file'
        )
        AND (
          ${q} = ''
          OR sess.title ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR sess.latest_message_text ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR cp.description ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR cp.commit_hash ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR la.resource_ref ILIKE '%' || ${escapedQ} || '%' ESCAPE '\\'
          OR sess.title % ${q}
          OR sess.latest_message_text % ${q}
          OR cp.description % ${q}
          OR la.resource_ref % ${q}
        )
    ),
    combined AS (
      ${combinedResults}
    ),
    scored AS (
      SELECT
        *,
        1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0 / 30.0) AS recency_score
      FROM combined
    )
    SELECT
      type,
      id,
      space_id AS "spaceId",
      session_id AS "sessionId",
      turn_id AS "turnId",
      sequence,
      title,
      excerpt,
      space_name AS "spaceName",
      owner_user_uuid AS "ownerUserUuid",
      space_profile AS "spaceProfile",
      session_title AS "sessionTitle",
      matched_field AS "matchedField",
      updated_at AS "updatedAt",
      text_score AS "textScore",
      recency_score AS "recencyScore",
      type_priority_score AS "typePriorityScore",
      membership_priority_score AS "membershipPriorityScore",
      label_ref AS "labelRef",
      label_name AS "labelName",
      label_resource_type AS "labelResourceType",
      label_resource_ref AS "labelResourceRef",
      (text_score * 0.68 + recency_score * 0.16 + type_priority_score * 0.05 + membership_priority_score * 0.11) AS score
    FROM scored
    ORDER BY score DESC, membership_priority_score DESC, text_score DESC, type_priority_score DESC, updated_at DESC
    LIMIT ${limit}
  `);
    });

    let profileMap = new Map<string, ReturnType<typeof fallbackPublicUserProfile>>();
    try {
      profileMap = await getProfilesByUuids(
        rows
          .filter((row) => row.type === "space" && row.ownerUserUuid)
          .map((row) => row.ownerUserUuid as string),
      );
    } catch (error) {
      logger.warn("[search] profile enrichment failed", {
        userUuid: user.uuid,
        ownerCount: new Set(rows.map((row) => row.ownerUserUuid).filter(Boolean)).size,
        error,
      });
    }
    return c.json({ items: rows.map((row) => mapRow(row, profileMap)), query: q, source: "remote" });
  } catch (error) {
    logger.warn("[search] global search failed", {
      userUuid: user.uuid,
      queryLength: q.length,
      error,
    });
    return c.json({ items: [], query: q, source: "remote", degraded: true });
  }
});

export default router;
