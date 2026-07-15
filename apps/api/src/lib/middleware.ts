import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthUserProfile } from "../auth.js";
import type { ExecutionAuthPrincipal } from "../auth.js";
import type { PreviewSessionPrincipal } from "../preview-sessions.js";
import type { WorkSessionPrincipal } from "../work-sessions.js";

/** AuthUserProfile with guaranteed uuid (returned after auth checks pass). */
export type AuthUser = AuthUserProfile & { uuid: string };

export type RequestPrincipal =
  | { type: "user"; user: AuthUser }
  | { type: "execution"; execution: ExecutionAuthPrincipal }
  | { type: "preview_session"; previewSession: PreviewSessionPrincipal }
  | { type: "work_session"; workSession: WorkSessionPrincipal };

import { config } from "../config.js";
import { getProfilesByUuids } from "../user-profiles.js";
import { getSpaceSandboxBySpaceId } from "../space-sandboxes.js";
import { spaceSandboxes } from "@cohub/db";
import { db } from "../db/index.js";
import { inArray } from "drizzle-orm";
import type { spaces } from "@cohub/db";

const principalToAuthUser = (principal: RequestPrincipal | null | undefined): AuthUser | null => {
  if (principal?.type === "user") return principal.user;
  if (principal?.type === "execution" && principal.execution.actorUserId) {
    return {
      uuid: principal.execution.actorUserId,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      execution: principal.execution,
    } as AuthUser & { execution: ExecutionAuthPrincipal };
  }
  if (principal?.type === "work_session") {
    return {
      uuid: principal.workSession.userUuid,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      workSession: principal.workSession,
    } as AuthUser & { workSession: WorkSessionPrincipal };
  }
  if (principal?.type === "preview_session") {
    return {
      uuid: principal.previewSession.userUuid,
      id: undefined,
      nick_name: undefined,
      phone_num: undefined,
      avatar_url: undefined,
      previewSession: principal.previewSession,
    } as AuthUser & { previewSession: PreviewSessionPrincipal };
  }
  return null;
};

// ── ID validation ────────────────────────────────────────────────────────────

/** Standard UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Short UUID (no hyphens): xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx */
const SHORT_UUID_REGEX = /^[0-9a-f]{32}$/i;

export const requireValidId = (value: string | null | undefined) =>
  Boolean(value && (UUID_REGEX.test(value) || SHORT_UUID_REGEX.test(value)));

// ── Auth helpers ─────────────────────────────────────────────────────────────

/** Returns the authenticated user or a 401 JSON Response. */
export const requireAuth = (c: Context): AuthUser | Response => {
  const user = getOptionalAuth(c);
  if (user) return user;
  return c.json({ message: "unauthorized" }, 401);
};

/**
 * Returns the authenticated user or a 401 JSON Response.
 * Usage: `const user = useAuth(c); if (user instanceof Response) return user;`
 */
export const useAuth = (c: Context): AuthUser | Response => requireAuth(c);

/**
 * Returns the authenticated user when present, otherwise null.
 * Use this for routes whose authorization is fully determined by RBAC
 * policies, including signed-in and anonymous access policies.
 */
export const getOptionalAuth = (c: Context): AuthUser | null => {
  return principalToAuthUser(c.get("principal") as RequestPrincipal | null | undefined);
};

export const authzDenied = (c: Context) => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal ? c.json({ message: "forbidden" }, 403) : c.json({ message: "unauthorized" }, 401);
};

export const getExecutionPrincipal = (c: Context): ExecutionAuthPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "execution" ? principal.execution : null;
};

export const getWorkSessionPrincipal = (c: Context): WorkSessionPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "work_session" ? principal.workSession : null;
};

export const getPreviewSessionPrincipal = (c: Context): PreviewSessionPrincipal | null => {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  return principal?.type === "preview_session" ? principal.previewSession : null;
};

// ── Internal request validation ──────────────────────────────────────────────

export const getRequestRemoteAddress = (c: Context) => {
  const info = getConnInfo(c);
  return info.remote.address || null;
};

export const isPrivateNetworkAddress = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;

  const ipv4Match = normalized.match(/^172\.(\d{1,3})\./);
  if (ipv4Match) {
    const secondOctet = Number.parseInt(ipv4Match[1] ?? "", 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:")) return true;

  return false;
};

const ensureSharedSecretRequest = (c: Context, header: string, expectedSecret: string) => {
  const secret = c.req.header(header);
  if (!secret || !expectedSecret) return c.json({ message: "forbidden" }, 403);
  const provided = new TextEncoder().encode(secret);
  const expected = new TextEncoder().encode(expectedSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ message: "forbidden" }, 403);
  }
  return null;
};

export const ensureInternalRequest = (c: Context) =>
  ensureSharedSecretRequest(c, "x-worker-secret", config.workerSecret);

export const ensureGatewayRequest = (c: Context) =>
  ensureSharedSecretRequest(c, "x-gateway-secret", config.gatewayInternalSecret);

// ── Space helpers ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_PUBLIC_AVATAR_URL_LENGTH = 2048;

export const normalizePublicAvatarUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PUBLIC_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const getSpacePublicProfile = (space: Pick<typeof spaces.$inferSelect, "meta">) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const profile = isRecord(meta.publicProfile) ? meta.publicProfile : {};
  return { avatarUrl: normalizePublicAvatarUrl(profile.avatarUrl) };
};

export const buildSpaceListItem = async (space: typeof spaces.$inferSelect) => {
  const sandbox = await getSpaceSandboxBySpaceId(space.id);
  return {
    ...space,
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: sandbox?.status ?? null,
  };
};

/**
 * Batch version: fetches sandbox statuses for all spaces in a single query
 * and returns the space list with sandboxStatus attached.
 */
export const buildSpaceListItems = async (spaceList: typeof spaces.$inferSelect[]) => {
  if (spaceList.length === 0) return [];

  const sandboxRows = await db
    .select({ spaceId: spaceSandboxes.spaceId, status: spaceSandboxes.status })
    .from(spaceSandboxes)
    .where(inArray(spaceSandboxes.spaceId, spaceList.map((s) => s.id)));

  const statusBySpaceId = new Map(sandboxRows.map((r) => [r.spaceId, r.status]));
  const profileByUserUuid = await getProfilesByUuids(spaceList.map((space) => space.userUuid));

  return spaceList.map((space) => ({
    ...space,
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: statusBySpaceId.get(space.id) ?? null,
    ownerProfile: profileByUserUuid.get(space.userUuid) ?? null,
  }));
};

export const buildStorageRepoName = (spaceId: string) => `space-${spaceId}`;
