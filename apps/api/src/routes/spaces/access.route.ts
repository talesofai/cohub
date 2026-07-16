import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { spaceAccessPolicies } from "@cohub/db";
import { requireValidId, useAuth, authzDenied } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import type { AccessPolicyRole } from "@cohub/db";

const router = new Hono();
const SIGNED_IN_VALID_ROLES = new Set<AccessPolicyRole>(["builder", "guest", null]);
const ANONYMOUS_VALID_ROLES = new Set<AccessPolicyRole>(["guest", null]);

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.view", { spaceId }))) return authzDenied(c);

  const [policy] = await db
    .select({
      signed_in_user: spaceAccessPolicies.signedInUserRole,
      anonymous_user: spaceAccessPolicies.anonymousUserRole,
    })
    .from(spaceAccessPolicies)
    .where(eq(spaceAccessPolicies.spaceId, spaceId))
    .limit(1);

  return c.json({
    signed_in_user: policy?.signed_in_user ?? null,
    anonymous_user: policy?.anonymous_user ?? null,
  });
});

router.patch("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "member.manage", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ signed_in_user?: AccessPolicyRole; anonymous_user?: AccessPolicyRole }>().catch(() => null);
  if (!body || (body.signed_in_user === undefined && body.anonymous_user === undefined)) {
    return c.json({ message: "invalid body" }, 400);
  }
  if (body.signed_in_user !== undefined && !SIGNED_IN_VALID_ROLES.has(body.signed_in_user)) {
    return c.json({ message: "access role must be guest, builder (signed-in only), or null" }, 400);
  }
  if (body.anonymous_user !== undefined && !ANONYMOUS_VALID_ROLES.has(body.anonymous_user)) {
    return c.json({ message: "access role must be guest or null" }, 400);
  }

  const updateSet: { signedInUserRole?: AccessPolicyRole; anonymousUserRole?: AccessPolicyRole; updatedBy: string; updatedAt: Date } = {
    updatedBy: user.uuid,
    updatedAt: new Date(),
  };
  if (body.signed_in_user !== undefined) updateSet.signedInUserRole = body.signed_in_user;
  if (body.anonymous_user !== undefined) updateSet.anonymousUserRole = body.anonymous_user;

  const [policy] = await db
    .insert(spaceAccessPolicies)
    .values({
      spaceId,
      signedInUserRole: body.signed_in_user ?? null,
      anonymousUserRole: body.anonymous_user ?? null,
      createdBy: user.uuid,
      updatedBy: user.uuid,
    })
    .onConflictDoUpdate({
      target: spaceAccessPolicies.spaceId,
      set: updateSet,
    })
    .returning();

  return c.json({
    signed_in_user: policy?.signedInUserRole ?? null,
    anonymous_user: policy?.anonymousUserRole ?? null,
  });
});

export default router;
