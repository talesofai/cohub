import { Hono } from "hono";
import { authzDenied, getOptionalAuth, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import {
  deleteSpaceVoiceLexiconEntry,
  listSpaceVoiceLexiconEntries,
  updateSpaceVoiceLexiconEntry,
  upsertSpaceVoiceLexiconEntry,
  VoiceLexiconConflictError,
  VoiceLexiconValidationError,
} from "../../voice-lexicon.js";

const router = new Hono();

function getSpaceId(value: string | undefined) {
  return value && requireValidId(value) ? value : null;
}

function getEntryId(value: string | undefined) {
  return value && requireValidId(value) ? value : null;
}

router.get("/", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = getSpaceId(c.req.param("id"));
  if (!spaceId) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  return c.json({ items: await listSpaceVoiceLexiconEntries(spaceId) });
});

router.post("/", async (c) => {
  const user = useAuth(c);
  const spaceId = getSpaceId(c.req.param("id"));
  if (!spaceId) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ term?: unknown; source?: unknown; originalText?: unknown }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);
  try {
    const item = await upsertSpaceVoiceLexiconEntry(spaceId, user.uuid, body);
    return c.json({ item }, 201);
  } catch (error) {
    if (error instanceof VoiceLexiconValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }
});

router.patch("/:entryId", async (c) => {
  const user = useAuth(c);
  const spaceId = getSpaceId(c.req.param("id"));
  const entryId = getEntryId(c.req.param("entryId"));
  if (!spaceId || !entryId) return c.json({ message: "entry not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ term?: unknown; source?: unknown; originalText?: unknown }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);
  try {
    const item = await updateSpaceVoiceLexiconEntry(spaceId, entryId, body);
    if (!item) return c.json({ message: "entry not found" }, 404);
    return c.json({ item });
  } catch (error) {
    if (error instanceof VoiceLexiconValidationError) return c.json({ message: error.message }, 400);
    if (error instanceof VoiceLexiconConflictError) return c.json({ message: error.message }, 409);
    throw error;
  }
});

router.delete("/:entryId", async (c) => {
  const user = useAuth(c);
  const spaceId = getSpaceId(c.req.param("id"));
  const entryId = getEntryId(c.req.param("entryId"));
  if (!spaceId || !entryId) return c.json({ message: "entry not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);
  const deleted = await deleteSpaceVoiceLexiconEntry(spaceId, entryId);
  if (!deleted) return c.json({ message: "entry not found" }, 404);
  return c.json({ ok: true });
});

export default router;
