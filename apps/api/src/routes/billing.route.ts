import { Hono, type Context } from "hono";
import { ApiError, isBillingApiError } from "../lib/billing-api-error.js";
import { billingOperations, COHUB_BILLING_FEATURES, COHUB_BILLING_TOKEN_TYPES, type CohubBillingFeatureKey } from "@cohub/billing";
import { config } from "../config.js";
import { jsonError } from "../lib/json-error.js";
import { getOptionalAuth, useAuth, type AuthUser } from "../lib/middleware.js";
import { resolveBillingUserId } from "../identity-bridge.js";

const router = new Hono();
const BILLING_PAGE_SIZE = 10;

function resolveTokenType(value: string | undefined) {
  const requestedTokenType = value?.trim();
  if (requestedTokenType && requestedTokenType !== COHUB_BILLING_TOKEN_TYPES.usdMicroCent) {
    return { error: "unsupported billing token type" as const };
  }
  return { tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent };
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function billingSettingsUrl(origin: string) {
  return new URL("/settings/billing", origin).toString();
}

function parseReturnUrl(value: unknown) {
  const fallback = config.webOrigin ? billingSettingsUrl(new URL(config.webOrigin).origin) : undefined;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    const allowedOrigin = config.webOrigin ? new URL(config.webOrigin).origin : url.origin;
    if (url.origin !== allowedOrigin || url.pathname !== "/settings/billing") return fallback;
    return billingSettingsUrl(allowedOrigin);
  } catch {
    return fallback;
  }
}

async function readCheckoutBody(c: Context) {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError({
      status: 400,
      message: "Invalid JSON body",
      code: "invalid_json_body",
      responseBody: null,
    });
  }
}

function parseRedemptionCode(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function billingApiErrorResponse(c: Context, error: { status: number; message: string; code?: string }) {
  return jsonError(c, {
    status: error.status,
    message: error.message,
    code: error.code,
  });
}

async function legacyBillingUserId(c: Context, user: AuthUser): Promise<string | Response> {
  try {
    return await resolveBillingUserId(user);
  } catch {
    return jsonError(c, {
      status: 503,
      message: "Billing identity is unavailable",
      code: "billing_identity_unavailable",
    });
  }
}

const BILLING_FEATURE_KEYS = new Set<string>(Object.values(COHUB_BILLING_FEATURES));

function resolveBillingFeatureKey(value: string): CohubBillingFeatureKey | null {
  return BILLING_FEATURE_KEYS.has(value) ? value as CohubBillingFeatureKey : null;
}

router.get("/credits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resolved = resolveTokenType(c.req.query("tokenType"));
  if ("error" in resolved) return c.json({ message: resolved.error }, 400);
  const userId = await legacyBillingUserId(c, user);
  if (userId instanceof Response) return userId;
  const credit = await billingOperations.getCreditStatus({
    userId,
    tokenType: resolved.tokenType,
  });
  return c.json(credit);
});

router.get("/balance-activities", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resolved = resolveTokenType(c.req.query("tokenType"));
  if ("error" in resolved) return c.json({ message: resolved.error }, 400);
  const userId = await legacyBillingUserId(c, user);
  if (userId instanceof Response) return userId;
  const activities = await billingOperations.listBalanceActivities({
    userId,
    tokenType: resolved.tokenType,
    page: parsePositiveInt(c.req.query("page"), 1, 10_000),
    limit: parsePositiveInt(c.req.query("limit"), BILLING_PAGE_SIZE, BILLING_PAGE_SIZE),
  });
  return c.json({ activities });
});

router.get("/catalog", async (c) => {
  const user = getOptionalAuth(c);
  try {
    const userId = user ? await legacyBillingUserId(c, user) : undefined;
    if (userId instanceof Response) return userId;
    const catalog = await billingOperations.getCatalog(
      userId ? { userId } : undefined,
    );
    return c.json({ catalog });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/features/:featureKey", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const featureKey = resolveBillingFeatureKey(c.req.param("featureKey"));
  if (!featureKey) return c.json({ message: "unsupported billing feature" }, 400);
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey,
    });
    return c.json({ enabled: Boolean(entitlement?.enabled) });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/subscriptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const subscriptions = await billingOperations.listSubscriptions({
      userId,
      page: parsePositiveInt(c.req.query("page"), 1, 10_000),
      limit: parsePositiveInt(c.req.query("limit"), BILLING_PAGE_SIZE, BILLING_PAGE_SIZE),
    });
    return c.json({ subscriptions });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/orders", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const body = await readCheckoutBody(c);
    const productKey =
      typeof (body as { productKey?: unknown }).productKey === "string"
        ? (body as { productKey: string }).productKey.trim()
        : "";
    if (!productKey) return c.json({ message: "Product key is required" }, 400);
    const checkout = await billingOperations.purchaseAddon({
      userId,
      productKey,
      returnUrl: parseReturnUrl((body as { returnUrl?: unknown }).returnUrl),
    });
    return c.json({ checkout });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/subscriptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const body = await readCheckoutBody(c);
    const productKey =
      typeof (body as { productKey?: unknown }).productKey === "string"
        ? (body as { productKey: string }).productKey.trim()
        : "";
    if (!productKey) return c.json({ message: "Product key is required" }, 400);
    const checkout = await billingOperations.createSubscription({
      userId,
      productKey,
      returnUrl: parseReturnUrl((body as { returnUrl?: unknown }).returnUrl),
    });
    return c.json({ checkout });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.delete("/subscriptions/:subscriptionId/checkout", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const subscription = await billingOperations.cancelSubscriptionCheckout({
      userId,
      subscriptionId: c.req.param("subscriptionId"),
    });
    return c.json({ subscription });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.patch("/subscriptions/:subscriptionId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const body = await readCheckoutBody(c);
    if ((body as { cancelAtPeriodEnd?: unknown }).cancelAtPeriodEnd !== true) {
      return c.json({ message: "cancelAtPeriodEnd must be true" }, 400);
    }
    const subscription = await billingOperations.cancelSubscriptionAutoRenew({
      userId,
      subscriptionId: c.req.param("subscriptionId"),
    });
    return c.json({ subscription });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/redemptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const userId = await legacyBillingUserId(c, user);
    if (userId instanceof Response) return userId;
    const body = await readCheckoutBody(c);
    const code = parseRedemptionCode((body as { code?: unknown }).code);
    if (!code) return c.json({ message: "Redemption code is required" }, 400);
    const redemption = await billingOperations.redeemCode({
      userId,
      code,
    });
    return c.json({ redemption });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

export default router;
