import { and, eq } from "drizzle-orm";
import { spaceCommerceBusinesses, spaces, works } from "@cohub/db";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { ApiError, createSdk } from "@talesofai-billing/sdk/base";
import { benefitsFeature, type CreditsBenefit } from "@talesofai-billing/sdk/admin/benefits";
import { businessesFeature } from "@talesofai-billing/sdk/admin/businesses";
import { customersFeature } from "@talesofai-billing/sdk/admin/customers";
import { ordersFeature } from "@talesofai-billing/sdk/admin/orders";
import { productsFeature, type Product } from "@talesofai-billing/sdk/admin/products";
import { providersFeature } from "@talesofai-billing/sdk/admin/providers";
import {
  billingOperations,
  createBusinessBillingOperations,
  COHUB_BILLING_FEATURES,
} from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";

const BILLING_NAMESPACE = "cohub_space";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * Resolves the space commerce entitlement. Returns `true` when entitled,
 * `false` when explicitly not entitled, or `null` when the billing service
 * could not be reached — letting callers distinguish a missing subscription
 * (402) from a transient verification failure (503) instead of masking a
 * billing outage as an upgrade prompt.
 */
export async function resolveSpaceCommerceEntitlement(
  userId: string,
): Promise<boolean | null> {
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey: COHUB_BILLING_FEATURES.spaceCommerce,
    });
    return Boolean(entitlement?.enabled);
  } catch (error) {
    logger.warn("[space-commerce] failed to check commerce entitlement", {
      userId,
      error,
    });
    return null;
  }
}

export class SpaceCommerceNotInitializedError extends Error {
  override name = "SpaceCommerceNotInitializedError";

  constructor(readonly spaceId: string) {
    super("Space commerce is not initialized");
  }
}

function requireBillingClientConfig() {
  const baseURL = config.talesofaiBillingBaseUrl?.trim();
  const adminApiKey = config.talesofaiBillingAdminApiKey?.trim();
  if (!baseURL || !adminApiKey) {
    throw new Error("Billing is not configured");
  }
  return { baseURL, adminApiKey };
}

export function createSpaceCommerceSdk() {
  const client = requireBillingClientConfig();
  return createSdk(client)
    .useAdmin(businessesFeature())
    .useAdmin(productsFeature())
    .useAdmin(benefitsFeature())
    .useAdmin(customersFeature())
    .useAdmin(ordersFeature())
    .useAdmin(providersFeature());
}

export type SpaceCommerceSdk = ReturnType<typeof createSpaceCommerceSdk>;

/**
 * Creates business-scoped billing operations bound to a space's billing
 * business. Used by work commerce to query viewer entitlements and consume
 * credits without exposing admin credentials to the work surface.
 */
export function createSpaceBusinessBillingOperations(businessKey: string) {
  const client = requireBillingClientConfig();
  return createBusinessBillingOperations({
    clientConfig: {
      baseUrl: client.baseURL,
      adminApiKey: client.adminApiKey,
      businessKey,
    },
    businessKey,
  });
}

const COHUB_BOUND_BENEFIT_KEYS_META_KEY = "cohub_bound_benefit_keys";

/**
 * Loads all credit benefits for a business, keyed by benefit key. Used by both
 * space and work commerce routes to populate product `display.creditBenefits`.
 */
export async function loadBusinessCreditBenefits(input: {
  sdk: SpaceCommerceSdk;
  businessKey: string;
}): Promise<Map<string, CreditsBenefit>> {
  const creditBenefits = new Map<string, CreditsBenefit>();
  let page = 1;
  while (true) {
    const result = await input.sdk.admin.benefits.list({
      business_key: input.businessKey,
      include_count: false,
      limit: 100,
      page,
    });
    for (const benefit of result.items) {
      if (benefit.type === "credits") creditBenefits.set(benefit.key, benefit);
    }
    if (!result.pagination.has_more) break;
    page += 1;
  }
  return creditBenefits;
}

/**
 * Reads bound benefit keys from a product's meta. Cohub stores the list of
 * bound benefit keys in `meta.cohub_bound_benefit_keys` so product-benefit
 * bindings can be resolved without extra API calls per product.
 */
export function readBoundBenefitKeys(product: Product): string[] {
  const value = product.meta?.[COHUB_BOUND_BENEFIT_KEYS_META_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeBusinessKeyValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function buildBillingBusinessKey(spaceId: string) {
  return `${BILLING_NAMESPACE}_${normalizeBusinessKeyValue(spaceId)}`;
}

function appendCheckoutQuery(urlString: string, input: { status: "success" | "failed" | "cancel"; orderId?: string | null }) {
  const url = new URL(urlString);
  url.searchParams.set("cohub_checkout", input.status);
  if (input.orderId) url.searchParams.set("cohub_order", input.orderId);
  return url.toString();
}

function appendCheckoutSessionPlaceholder(urlString: string) {
  const url = new URL(urlString);
  url.searchParams.set("checkout_session_id", "{CHECKOUT_SESSION_ID}");
  return url
    .toString()
    .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
}

function buildBillingBusinessName(input: { spaceName: string; spaceId: string }) {
  const name = input.spaceName.trim() || input.spaceId;
  const suffix = input.spaceId.slice(0, 8);
  return `Cohub Space · ${name} · ${suffix}`.slice(0, 256);
}

export async function getSpaceCommerceBusiness(spaceId: string) {
  const [mapping] = await db
    .select()
    .from(spaceCommerceBusinesses)
    .where(eq(spaceCommerceBusinesses.spaceId, spaceId))
    .limit(1);
  return mapping ?? null;
}

export async function ensureSpaceCommerceBusiness(spaceId: string) {
  const existing = await getSpaceCommerceBusiness(spaceId);
  if (existing) return existing;

  const [space] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) throw new Error("Space not found");

  const businessKey = buildBillingBusinessKey(space.id);
  const sdk = createSpaceCommerceSdk();
  try {
    await sdk.admin.businesses.create({
      key: businessKey,
      name: buildBillingBusinessName({ spaceName: space.name, spaceId: space.id }),
      status: "active",
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
  }

  const [mapping] = await db
    .insert(spaceCommerceBusinesses)
    .values({
      spaceId: space.id,
      billingBusinessKey: businessKey,
    })
    .onConflictDoUpdate({
      target: spaceCommerceBusinesses.spaceId,
      set: {
        billingBusinessKey: businessKey,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!mapping) throw new Error("Failed to persist space commerce business mapping");
  return mapping;
}

export async function requireSpaceCommerceBusiness(spaceId: string) {
  const mapping = await getSpaceCommerceBusiness(spaceId);
  if (!mapping) throw new SpaceCommerceNotInitializedError(spaceId);
  return mapping;
}

export async function getSpaceCommerceBusinessKey(spaceId: string) {
  return (await getSpaceCommerceBusiness(spaceId))?.billingBusinessKey ?? null;
}

export async function requireSpaceCommerceBusinessKey(spaceId: string) {
  return (await requireSpaceCommerceBusiness(spaceId)).billingBusinessKey;
}

export async function ensureSpaceCommerceBusinessKey(spaceId: string) {
  return (await ensureSpaceCommerceBusiness(spaceId)).billingBusinessKey;
}

export async function getWorkCommerceContextById(workId: string) {
  const [row] = await db
    .select({
      workId: works.id,
      workSlug: works.slug,
      workStatus: works.status,
      workVisibility: works.visibility,
      spaceId: works.spaceId,
    })
    .from(works)
    .where(eq(works.id, workId))
    .limit(1);
  if (!row) return null;
  return row;
}

export async function getWorkCommerceContextBySpaceAndSlug(input: {
  spaceId: string;
  workSlug: string;
}) {
  const [row] = await db
    .select({
      workId: works.id,
      workSlug: works.slug,
      workStatus: works.status,
      workVisibility: works.visibility,
      spaceId: works.spaceId,
    })
    .from(works)
    .where(and(eq(works.spaceId, input.spaceId), eq(works.slug, input.workSlug)))
    .limit(1);
  return row ?? null;
}

export function buildWorkCheckoutReturnUrls(input: { workUrl: string; orderId?: string | null }) {
  return {
    successRedirectUrl: appendCheckoutQuery(input.workUrl, { status: "success", orderId: input.orderId }),
    failedRedirectUrl: appendCheckoutQuery(input.workUrl, { status: "failed", orderId: input.orderId }),
    cancelRedirectUrl: appendCheckoutQuery(input.workUrl, { status: "cancel", orderId: input.orderId }),
  };
}

export function buildEmbeddedWorkCheckoutReturnUrl(input: { workUrl: string }) {
  return appendCheckoutSessionPlaceholder(input.workUrl);
}

export function buildProviderAwareWorkCheckoutRedirects(input: {
  workUrl: string;
  activeProviderKey: "not_configured" | "waffo" | "stripe";
  checkoutMode?: "hosted_page" | "embedded_page" | null;
}) {
  const useEmbedded =
    input.activeProviderKey === "stripe" &&
    (input.checkoutMode === "embedded_page" || !input.checkoutMode);
  if (useEmbedded) {
    return {
      checkout_ui_mode: "embedded_page" as const,
      checkout_return_url: buildEmbeddedWorkCheckoutReturnUrl(input),
      checkout_redirect_on_completion: "if_required" as const,
    };
  }
  const urls = buildWorkCheckoutReturnUrls({ workUrl: input.workUrl });
  return {
    success_redirect_url: urls.successRedirectUrl,
    failed_redirect_url: urls.failedRedirectUrl,
    cancel_redirect_url: urls.cancelRedirectUrl,
  };
}
