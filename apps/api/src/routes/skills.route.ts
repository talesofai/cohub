import { Hono } from "hono";
import { hasPermission } from "../permissions.js";
import { getOptionalAccountAuth, getOptionalAuth, authzDenied } from "../lib/middleware.js";
import { listSkills } from "../skills.js";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.get("/", async (c) => {
  const actor = getOptionalAuth(c);
  // Scoped principals may authorize Space access, never account-private paths.
  const accountUser = getOptionalAccountAuth(c);
  const spaceId = c.req.query("spaceId")?.trim() || null;

  if (!accountUser && !spaceId) {
    return c.json({ skills: [] });
  }

  if (spaceId && !(await hasPermission(actor, "space.view", { spaceId }))) {
    return authzDenied(c);
  }

  try {
    return c.json({
      skills: await listSkills({
        userId: accountUser?.uuid ?? null,
        spaceId,
      }),
    });
  } catch (error) {
    logger.error("[skills] failed to load skills", error);
    return c.json({ message: "failed to load skills" }, 502);
  }
});

export default router;
