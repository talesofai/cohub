import { Hono } from "hono";
import { isBillingApiError } from "../lib/billing-api-error.js";
import { authzDenied, getOptionalAuth, requireValidId, useAuth } from "../lib/middleware.js";
import { handleWorkCommerceRouteError } from "../lib/commerce-http.js";
import { hasPermission } from "../permissions.js";
import {
  buildWorkCheckoutReturnUrls,
  createSpaceCommerceSdk,
  createSpaceBusinessBillingOperations,
  getWorkCommerceContextById,
  loadBusinessCreditBenefits,
  readBoundBenefitKeys,
  requireSpaceCommerceBusinessKey,
} from "../lib/space-commerce.js";
import { serializeProduct, serializeOrder } from "../lib/commerce-serialize.js";
import { db } from "../db/index.js";
import { spaces, userProfiles } from "@cohub/db";
import { eq, or } from "drizzle-orm";
import { config } from "../config.js";
import {
  identityEquals,
  resolveBillingUserId,
  resolveBillingUserIdForStoredPrincipal,
} from "../identity-bridge.js";

const router = new Hono();

async function getPublishedWorkOrDeny(workId: string, userUuid?: string | null) {
  const work = await getWorkCommerceContextById(workId);
  if (work?.workStatus !== "published") return { error: "work not found" as const };
  if ((work.workVisibility ?? "public") === "space") {
    if (!userUuid) return { auth: "required" as const, work };
  }
  return { work };
}

async function resolvePublicWorkUrl(input: { spaceId: string; workSlug: string }) {
  const [row] = await db
    .select({ username: userProfiles.username, spaceSlug: spaces.slug })
    .from(spaces)
    .innerJoin(userProfiles, or(
      eq(userProfiles.userUuid, spaces.userUuid),
      eq(userProfiles.logtoUserId, spaces.userUuid),
    ))
    .where(eq(spaces.id, input.spaceId))
    .limit(1);
  if (!row?.username || !row.spaceSlug) return null;
  const origin = config.webOrigin?.replace(/\/+$/, "") ?? "https://dev.cohub.run";
  return `${origin}/${encodeURIComponent(row.username)}/${encodeURIComponent(row.spaceSlug)}/w/${encodeURIComponent(input.workSlug)}`;
}

router.post("/works/:id/commerce/products/resolve", async (c) => {
  const principal = getOptionalAuth(c);
  const workId = c.req.param("id");
  if (!requireValidId(workId)) return c.json({ message: "work not found" }, 404);
  const resolved = await getPublishedWorkOrDeny(workId, principal?.uuid ?? null);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ("auth" in resolved) return authzDenied(c);
  if ((resolved.work.workVisibility ?? "public") === "space" && !(await hasPermission(principal, "space.view", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { productKeys?: unknown } | null;
  const requested = Array.isArray(body?.productKeys)
    ? [...new Set(body.productKeys.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
  if (requested.length === 0) return c.json({ message: "productKeys is required" }, 400);
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.work.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const [products, creditBenefitsMap] = await Promise.all([
      Promise.all(requested.map(async (productKey) => {
        try {
          const product = await sdk.admin.products.get({ business_key: businessKey, product_key: productKey });
          if (product.status !== "active" || product.visibility !== "public" || product.billing_type !== "one_time") return null;
          return product;
        } catch (error) {
          if (isBillingApiError(error) && error.status === 404) return null;
          throw error;
        }
      })),
      await loadBusinessCreditBenefits({ sdk, businessKey }),
    ]);
    const visibleProducts = products.filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
    const serializedProducts = [];
    for (const item of visibleProducts) {
      const boundKeys = await readBoundBenefitKeys(item);
      const boundCredits = boundKeys
        .map((key) => creditBenefitsMap.get(key))
        .filter((b): b is NonNullable<typeof b> => Boolean(b));
      serializedProducts.push(serializeProduct(item, boundCredits));
    }
    return c.json({
      products: serializedProducts,
    });
  } catch (error) {
    const response = handleWorkCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/works/:id/commerce/entitlements", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const workId = c.req.param("id");
  if (!requireValidId(workId)) return c.json({ message: "work not found" }, 404);
  const resolved = await getPublishedWorkOrDeny(workId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.work.workVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  try {
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.work.spaceId);
    const ops = await createSpaceBusinessBillingOperations(businessKey);
    const billingUserId = await resolveBillingUserId(user);
    const state = await ops.getEntitlements({ userId: billingUserId });
    const creditBalance = state.credits.find((c: { tokenType: string }) => c.tokenType === "cohub_credit");
    return c.json({
      entitlements: state.entitlements.map((entitlement: { key: string; enabled: boolean; metadata: Record<string, string | number | boolean> }) => ({
        benefitKey: entitlement.key,
        enabled: entitlement.enabled,
        metadata: entitlement.metadata,
      })),
      credits: {
        available: creditBalance?.availableBalance ?? 0,
        net: creditBalance?.netBalance ?? 0,
      },
      businessKey,
    });
  } catch (error) {
    const response = handleWorkCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post("/works/:id/commerce/credits/consume", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const workId = c.req.param("id");
  if (!requireValidId(workId)) return c.json({ message: "work not found" }, 404);
  const resolved = await getPublishedWorkOrDeny(workId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.work.workVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    amount?: unknown;
    operationId?: unknown;
    consumerUserId?: unknown;
    reason?: unknown;
  } | null;
  const rawAmount = typeof body?.amount === "number" ? body.amount : null;
  if (rawAmount === null || !Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
    return c.json({ message: "amount must be a positive safe integer" }, 400);
  }
  const operationId = typeof body?.operationId === "string" ? body.operationId.trim() : "";
  if (!operationId || operationId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(operationId)) {
    return c.json({ message: "operationId must be 1-128 chars of [a-zA-Z0-9_-]" }, 400);
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 512) : undefined;

  const consumerUserId = typeof body?.consumerUserId === "string" ? body.consumerUserId.trim() : null;
  if (consumerUserId && !identityEquals(user, consumerUserId)) {
    if (!(await hasPermission(user, "space.commerce.manage", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  }
  try {
    const targetUserId = consumerUserId && !identityEquals(user, consumerUserId)
      ? await resolveBillingUserIdForStoredPrincipal(consumerUserId)
      : await resolveBillingUserId(user);
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.work.spaceId);
    const ops = await createSpaceBusinessBillingOperations(businessKey);
    const result = await ops.consume({
      userId: targetUserId,
      amount: rawAmount,
      operationId,
      sourceId: resolved.work.workId,
      reason,
    });
    return c.json({
      status: result.status,
      amount: result.amount,
      remaining: result.remaining,
      shortfall: result.shortfall,
      businessKey,
    });
  } catch (error) {
    const response = handleWorkCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.post("/works/:id/commerce/purchase", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const workId = c.req.param("id");
  if (!requireValidId(workId)) return c.json({ message: "work not found" }, 404);
  const resolved = await getPublishedWorkOrDeny(workId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.work.workVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { productKey?: unknown } | null;
  const productKey = typeof body?.productKey === "string" ? body.productKey.trim() : "";
  if (!productKey) return c.json({ message: "productKey is required" }, 400);
  try {
    const billingUserId = await resolveBillingUserId(user);
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.work.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const product = await sdk.admin.products.get({ business_key: businessKey, product_key: productKey });
    if (product.status !== "active" || product.visibility !== "public" || product.billing_type !== "one_time") {
      return c.json({ message: "product is not available" }, 400);
    }
    const workUrl = await resolvePublicWorkUrl({
      spaceId: resolved.work.spaceId,
      workSlug: resolved.work.workSlug,
    });
    if (!workUrl) return c.json({ message: "work public url is unavailable" }, 409);
    const provisionalRedirects = buildWorkCheckoutReturnUrls({ workUrl });
    const result = await sdk.admin.orders.create({
      business_key: businessKey,
      external_user_id: billingUserId,
      product_key: product.key,
      billing_reason: "purchase",
      success_redirect_url: provisionalRedirects.successRedirectUrl,
      failed_redirect_url: provisionalRedirects.failedRedirectUrl,
      cancel_redirect_url: provisionalRedirects.cancelRedirectUrl,
      metadata: {
        source: "cohub",
        source_type: "work",
        cohub_space_id: resolved.work.spaceId,
        cohub_work_id: resolved.work.workId,
      },
    });
    return c.json({ checkout: {
      providerKey: result.checkout?.provider_key ?? null,
      checkoutUrl: result.checkout?.checkout_url ?? null,
      checkoutUsable: result.checkout?.checkout_usable === true,
      status: result.checkout?.status ?? null,
      message: result.checkout?.message ?? null,
      orderId: result.order.id,
      productKey: result.order.product_key_snapshot,
    } });
  } catch (error) {
    const response = handleWorkCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

router.get("/works/:id/commerce/orders/:orderId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const workId = c.req.param("id");
  const orderId = c.req.param("orderId");
  if (!requireValidId(workId)) return c.json({ message: "work not found" }, 404);
  if (!requireValidId(orderId)) return c.json({ message: "order not found" }, 404);
  const resolved = await getPublishedWorkOrDeny(workId, user.uuid);
  if ("error" in resolved) return c.json({ message: resolved.error }, 404);
  if ((resolved.work.workVisibility ?? "public") === "space" && !(await hasPermission(user, "space.view", { spaceId: resolved.work.spaceId }))) return authzDenied(c);
  try {
    const billingUserId = await resolveBillingUserId(user);
    const businessKey = await requireSpaceCommerceBusinessKey(resolved.work.spaceId);
    const sdk = await createSpaceCommerceSdk();
    const order = await sdk.admin.orders.get({
      business_key: businessKey,
      order_id: orderId,
    });
    if (order.external_user_id !== billingUserId) return authzDenied(c);
    return c.json({ order: serializeOrder(order) });
  } catch (error) {
    const response = handleWorkCommerceRouteError(c, error);
    if (response) return response;
    throw error;
  }
});

export default router;
