import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { config } from "../config.js";
import { requireValidId, useAuth } from "../lib/middleware.js";
import { ensureCurrentUserProfile, updateCurrentUserProfile, UsernameConflictError, validateUsername } from "../user-profiles.js";
import {
  deleteUserVoiceLexiconEntry,
  listUserVoiceLexiconEntries,
  updateUserVoiceLexiconEntry,
  upsertUserVoiceLexiconEntry,
  VoiceLexiconConflictError,
  VoiceLexiconValidationError,
} from "../voice-lexicon.js";

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
  const profile = await ensureCurrentUserProfile(user);
  return c.json({ uuid: user.uuid, profile });
});

router.patch("/profile", async (c) => {
  const user = useAuth(c);
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
    throw error;
  }
});

router.get("/rules", async (c) => {
  const user = useAuth(c);
  try {
    return c.json(await readUserRules(user.uuid));
  } catch {
    return c.json({ message: "failed to load user rules" }, 500);
  }
});

router.get("/voice-lexicon", async (c) => {
  const user = useAuth(c);
  return c.json({ items: await listUserVoiceLexiconEntries(user.uuid) });
});

router.post("/voice-lexicon", async (c) => {
  const user = useAuth(c);
  const body = await c.req.json<{ term?: unknown; source?: unknown; originalText?: unknown }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);
  try {
    const item = await upsertUserVoiceLexiconEntry(user.uuid, body);
    return c.json({ item }, 201);
  } catch (error) {
    if (error instanceof VoiceLexiconValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }
});

router.patch("/voice-lexicon/:entryId", async (c) => {
  const user = useAuth(c);
  const entryId = c.req.param("entryId");
  if (!entryId || !requireValidId(entryId)) return c.json({ message: "entry not found" }, 404);
  const body = await c.req.json<{ term?: unknown; source?: unknown; originalText?: unknown }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);
  try {
    const item = await updateUserVoiceLexiconEntry(user.uuid, entryId, body);
    if (!item) return c.json({ message: "entry not found" }, 404);
    return c.json({ item });
  } catch (error) {
    if (error instanceof VoiceLexiconValidationError) return c.json({ message: error.message }, 400);
    if (error instanceof VoiceLexiconConflictError) return c.json({ message: error.message }, 409);
    throw error;
  }
});

router.delete("/voice-lexicon/:entryId", async (c) => {
  const user = useAuth(c);
  const entryId = c.req.param("entryId");
  if (!entryId || !requireValidId(entryId)) return c.json({ message: "entry not found" }, 404);
  const deleted = await deleteUserVoiceLexiconEntry(user.uuid, entryId);
  if (!deleted) return c.json({ message: "entry not found" }, 404);
  return c.json({ ok: true });
});

export default router;
