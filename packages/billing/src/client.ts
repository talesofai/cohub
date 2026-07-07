import {
  benefitsFeature,
  type Benefit,
  type CreditsBenefit,
} from "@talesofai-billing/sdk/admin/benefits";
import { businessesFeature } from "@talesofai-billing/sdk/admin/businesses";
import {
  creditsFeature,
  type CreditGrant,
  type CreditTransaction,
  type UsageOverage,
} from "@talesofai-billing/sdk/admin/credits";
import { customersFeature } from "@talesofai-billing/sdk/admin/customers";
import {
  type CreateOrderResponse,
  type OrderCheckout,
  ordersFeature,
} from "@talesofai-billing/sdk/admin/orders";
import {
  type Product,
  productsFeature,
} from "@talesofai-billing/sdk/admin/products";
import { redemptionCodesFeature } from "@talesofai-billing/sdk/admin/redemption-codes";
import { providersFeature } from "@talesofai-billing/sdk/admin/providers";
import {
  type CreateSubscriptionResponse,
  type Subscription,
  type SubscriptionCheckout,
  subscriptionsFeature,
} from "@talesofai-billing/sdk/admin/subscriptions";
import { ApiError, createSdk } from "@talesofai-billing/sdk/base";
import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  type BillingAccountState,
  type BillingActivePaymentProviderKey,
  type BillingBalanceActivity,
  type BillingBalanceActivityList,
  type BillingBalanceActivityListInput,
  type BillingCatalog,
  type BillingCatalogProduct,
  type BillingCheckoutInput,
  type BillingCheckoutResult,
  type BillingProductCreditBenefit,
  type BillingCreditBalance,
  type BillingCreditExpiryGroup,
  type BillingCreditGrantStatus,
  type BillingCreditStatus,
  type BillingCreditUnit,
  type BusinessBillingOperations,
  type BusinessCreditConsumeResult,
  type BillingFeatureEntitlement,
  type BillingFeatureLimitCheck,
  type BillingFeatureLimitInput,
  type BillingHistoryListInput,
  type BillingOperations,
  type BillingPaymentStatus,
  type BillingPaymentProviderKey,
  type BillingPluginStatus,
  type BillingRedemptionInput,
  type BillingRedemptionResult,
  type BillingSubscriptionHistoryList,
  type BillingSubscriptionHistoryStatus,
  type BillingUsagePreflight,
  type BillingUsagePreflightInput,
  type BillingUsageRecordInput,
  type BillingUsageRecordResult,
  type BillingUserRef,
} from "./interfaces.js";

export type BillingClientConfig = {
  baseUrl: string;
  businessKey: string;
  adminApiKey: string;
};

export type BillingRuntimeConfig = {
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
};

export type BillingRedisClient = Pick<Redis, "get" | "set" | "eval">;

let runtimeConfig: BillingRuntimeConfig = {};
let checkoutLockRedis: BillingRedisClient | null = null;

export function configureBillingRuntime(input: {
  config?: BillingRuntimeConfig;
  redis?: BillingRedisClient | null;
}) {
  runtimeConfig = input.config ?? {};
  checkoutLockRedis = input.redis ?? null;
}

export class BillingConfigurationError extends Error {
  constructor(message = "Talesofai Billing is not configured") {
    super(message);
    this.name = "BillingConfigurationError";
  }
}

export function resolveBillingClientConfig(config: BillingRuntimeConfig = runtimeConfig): BillingClientConfig | null {
  const baseUrl = config.talesofaiBillingBaseUrl?.trim();
  const businessKey = config.talesofaiBillingBusinessKey?.trim();
  const adminApiKey = config.talesofaiBillingAdminApiKey?.trim();
  if (!baseUrl || !businessKey || !adminApiKey) return null;
  return { baseUrl, businessKey, adminApiKey };
}

export function isBillingConfigured(): boolean {
  return resolveBillingClientConfig() !== null;
}

function createConfiguredSdk(input: BillingClientConfig) {
  return createSdk({
    baseURL: input.baseUrl,
    adminApiKey: input.adminApiKey,
  })
    .useAdmin(benefitsFeature())
    .useAdmin(businessesFeature())
    .useAdmin(customersFeature())
    .useAdmin(creditsFeature())
    .useAdmin(productsFeature())
    .useAdmin(ordersFeature())
    .useAdmin(redemptionCodesFeature())
    .useAdmin(subscriptionsFeature())
    .useAdmin(providersFeature());
}

type ConfiguredBillingSdk = ReturnType<typeof createConfiguredSdk>;

const ENSURE_CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000;
const BILLING_STATIC_CATALOG_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CHECKOUT_LOCK_TTL_MS = 30_000;
const CHECKOUT_LOCK_RETRY_DELAY_MS = 250;
const CHECKOUT_LOCK_RETRY_COUNT = 24;
const CREDIT_LIST_PAGE_LIMIT = 100;
const CREDIT_LIST_MAX_PAGES = 20;
const CREDIT_GRANT_DISPLAY_STATUSES = [
  "active",
  "depleted",
  "expired",
] as const;
const BILLING_CURRENT_SUBSCRIPTION_STATUSES = ["trialing", "active"] as const;
const BILLING_BLOCKING_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "payment_conflicted",
] as const;
const BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
] as const;
const CREDIT_BENEFIT_DISPLAY_NAMES: Record<string, string> = {
  free_monthly_credits: "Free Plan Credits",
};
type BillingListPage<T> = {
  items: T[];
  pagination: {
    has_more: boolean;
  };
};
type CreditGrantDisplayStatus = (typeof CREDIT_GRANT_DISPLAY_STATUSES)[number];

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(8));
}

function normalizeRedemptionCode(value: string): string {
  return value.trim();
}

function redemptionIdempotencyKey(input: {
  userId: string;
  code: string;
}): string {
  const codeHash = createHash("sha256")
    .update(normalizeRedemptionCode(input.code))
    .digest("hex");
  return `cohub:billing:redemption:${input.userId}:${codeHash}`;
}

function roundUsd(
  value: number,
  decimalPlaces: number = COHUB_BILLING_CREDIT_UNITS.usdMicroCent.usdDecimalPlaces,
): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimalPlaces));
}

function getCreditUnit(tokenType: string): BillingCreditUnit {
  if (tokenType === COHUB_BILLING_TOKEN_TYPES.usdMicroCent)
    return COHUB_BILLING_CREDIT_UNITS.usdMicroCent;
  if (tokenType === COHUB_BILLING_TOKEN_TYPES.cohubCredit)
    return COHUB_BILLING_CREDIT_UNITS.cohubCredit;
  return {
    tokenType,
    displayCurrency: "USD",
    displayUnit: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.displayUnit,
    unitToUsd: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitToUsd,
    unitsPerUsd: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
    usdDecimalPlaces: COHUB_BILLING_CREDIT_UNITS.usdMicroCent.usdDecimalPlaces,
  };
}

function amountToUsd(amount: number, tokenType: string): number {
  const unit = getCreditUnit(tokenType);
  return roundUsd(amount * unit.unitToUsd, unit.usdDecimalPlaces);
}

function usdToAmount(amountUsd: number, tokenType: string): number {
  const unit = getCreditUnit(tokenType);
  const roundedUsd = roundUsd(amountUsd, unit.usdDecimalPlaces);
  if (roundedUsd <= 0) return 0;
  return Math.round(roundedUsd * unit.unitsPerUsd);
}

function mapCreditBalance(
  summary: BillingCreditBalance["raw"],
): BillingCreditBalance {
  return {
    tokenType: summary.token_type,
    availableBalance: summary.available_balance,
    openOverageBalance: summary.open_overage_balance,
    netBalance: summary.net_balance,
    raw: summary,
  };
}

function mergeFeatureMetadata(
  current: BillingFeatureEntitlement["metadata"],
  next: BillingFeatureEntitlement["metadata"],
): BillingFeatureEntitlement["metadata"] {
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key];
    if (typeof value === "boolean") {
      merged[key] = existing === true || value;
      continue;
    }
    if (typeof value === "number") {
      merged[key] =
        typeof existing === "number" ? Math.max(existing, value) : value;
      continue;
    }
    if (existing === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function mapFeatureEntitlements(
  activeBenefits: BillingFeatureEntitlement["grants"],
): BillingFeatureEntitlement[] {
  const byKey = new Map<string, BillingFeatureEntitlement>();
  for (const benefit of activeBenefits) {
    const metadata = benefit.config.metadata ?? {};
    const enabled = metadata.enabled !== false;
    const existing = byKey.get(benefit.benefit_key);
    if (existing) {
      existing.enabled = existing.enabled || enabled;
      existing.metadata = mergeFeatureMetadata(existing.metadata, metadata);
      existing.grants.push(benefit);
      continue;
    }
    byKey.set(benefit.benefit_key, {
      key: benefit.benefit_key,
      enabled,
      metadata: { ...metadata },
      grants: [benefit],
    });
  }
  return [...byKey.values()];
}

async function getCustomerStateOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<BillingAccountState | null> {
  try {
    const state = await input.sdk.admin.customers.getState({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      credits: state.credits.map(mapCreditBalance),
      entitlements: mapFeatureEntitlements(state.active_benefits),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

async function getCustomerCreditsOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<(BillingUserRef & { credits: BillingCreditBalance[] }) | null> {
  try {
    const credits = await input.sdk.admin.customers.getCredits({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      credits: credits.credits.map(mapCreditBalance),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

async function getCustomerEntitlementsOrEmpty(input: {
  sdk: ConfiguredBillingSdk;
  businessKey: string;
  userId: string;
}): Promise<
  (BillingUserRef & { entitlements: BillingFeatureEntitlement[] }) | null
> {
  try {
    const entitlements = await input.sdk.admin.customers.getEntitlements({
      external_user_id: input.userId,
      business_key: input.businessKey,
    });
    return {
      userId: input.userId,
      entitlements: mapFeatureEntitlements(entitlements.active_benefits),
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

function findBalance(
  credits: BillingCreditBalance[],
  tokenType: string,
): BillingCreditBalance | null {
  return credits.find((credit) => credit.tokenType === tokenType) ?? null;
}

function daysUntil(
  expiresAt: string | null | undefined,
  now = new Date(),
): number | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return null;
  return Math.ceil((expires.getTime() - now.getTime()) / 86_400_000);
}

function getExpiryGroupKey(
  daysRemaining: number | null,
): BillingCreditExpiryGroup["key"] {
  if (daysRemaining === null) return "never";
  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= 7) return "lt_7d";
  if (daysRemaining <= 30) return "lt_30d";
  return "gte_30d";
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[_\s.-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveCreditGrantBenefitName(grant: CreditGrant): string | null {
  const benefitName = grant.benefit_name?.trim();
  if (benefitName) return benefitName;
  const benefitKey = grant.benefit_key?.trim();
  if (!benefitKey) return null;
  return (
    CREDIT_BENEFIT_DISPLAY_NAMES[benefitKey] ?? humanizeIdentifier(benefitKey)
  );
}

function optionalAmount(value: number | undefined, tokenType: string) {
  if (typeof value !== "number") return { amount: null, amountUsd: null };
  return {
    amount: normalizeAmount(value),
    amountUsd: amountToUsd(value, tokenType),
  };
}

function getCreditGrantUnavailableReasons(
  grant: CreditGrant,
): string[] {
  return Array.isArray(grant.unavailable_reasons)
    ? grant.unavailable_reasons
    : [];
}

function isCreditGrantDisplayable(grant: CreditGrant): boolean {
  if (grant.available_now !== false) return true;
  const reasons = getCreditGrantUnavailableReasons(grant);
  return reasons.length > 0 && reasons.every((reason) => reason === "depleted");
}

function mapCreditGrant(
  grant: CreditGrant,
  now = new Date(),
): BillingCreditGrantStatus {
  const daysRemaining = daysUntil(grant.expires_at ?? null, now);
  const consumed = optionalAmount(grant.consumed_amount, grant.token_type);
  const usageConsumed = optionalAmount(
    grant.usage_consumed_amount,
    grant.token_type,
  );
  const settledOverage = optionalAmount(
    grant.settled_overage_amount,
    grant.token_type,
  );
  const originalAmount =
    typeof grant.original_amount === "number"
      ? normalizeAmount(grant.original_amount)
      : null;
  const originalAmountUsd =
    typeof grant.original_amount === "number"
      ? amountToUsd(grant.original_amount, grant.token_type)
      : null;
  const consumedPercent =
    originalAmount && consumed.amount !== null
      ? Math.min(
          100,
          Math.max(
            0,
            Number(((consumed.amount / originalAmount) * 100).toFixed(1)),
          ),
        )
      : null;
  return {
    id: grant.id,
    tokenType: grant.token_type,
    benefitKey: grant.benefit_key ?? null,
    benefitName: resolveCreditGrantBenefitName(grant),
    grantKind: grant.grant_kind ?? null,
    sourceType: grant.source_type ?? null,
    sourceId: grant.source_id ?? null,
    status: grant.status,
    availableNow: grant.available_now ?? null,
    unavailableReasons: getCreditGrantUnavailableReasons(grant),
    remainingAmount: normalizeAmount(grant.remaining_amount),
    remainingAmountUsd: amountToUsd(grant.remaining_amount, grant.token_type),
    originalAmount,
    originalAmountUsd,
    consumedAmount: consumed.amount,
    consumedAmountUsd: consumed.amountUsd,
    usageConsumedAmount: usageConsumed.amount,
    usageConsumedAmountUsd: usageConsumed.amountUsd,
    settledOverageAmount: settledOverage.amount,
    settledOverageAmountUsd: settledOverage.amountUsd,
    consumedPercent,
    effectiveAt: grant.effective_at ?? null,
    expiresAt: grant.expires_at ?? null,
    daysRemaining,
    createdAt: grant.created_at,
  };
}

function createdAtDesc(
  left: BillingCreditGrantStatus,
  right: BillingCreditGrantStatus,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightValue - leftValue;
}

function groupCreditGrants(
  grants: BillingCreditGrantStatus[],
): BillingCreditExpiryGroup[] {
  const orderedKeys: BillingCreditExpiryGroup["key"][] = [
    "lt_7d",
    "lt_30d",
    "gte_30d",
    "never",
    "expired",
  ];
  const byKey = new Map<
    BillingCreditExpiryGroup["key"],
    BillingCreditExpiryGroup
  >();
  for (const key of orderedKeys) {
    byKey.set(key, {
      key,
      remainingAmountUsd: 0,
      grants: [],
    });
  }
  for (const grant of grants) {
    const key = getExpiryGroupKey(grant.daysRemaining);
    const group = byKey.get(key);
    if (!group) continue;
    group.remainingAmountUsd = normalizeAmount(
      group.remainingAmountUsd + grant.remainingAmountUsd,
    );
    group.grants.push(grant);
  }
  for (const group of byKey.values()) {
    group.grants.sort(createdAtDesc);
  }
  return orderedKeys
    .map((key) => byKey.get(key))
    .filter(
      (group): group is BillingCreditExpiryGroup =>
        !!group && group.grants.length > 0,
    );
}

type UsageActivityDraft = {
  id: string;
  tokenType: string;
  usageType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  reason: string | null;
  createdAt: string;
  coveredAmountUsd: number;
  overageAmountUsd: number;
};

function balanceActivityCreatedAtDesc(a: { createdAt: string }, b: { createdAt: string }): number {
  const leftTime = Date.parse(a.createdAt);
  const rightTime = Date.parse(b.createdAt);
  const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
  return rightValue - leftValue;
}

function formatBillingLabel(value: string | null): string {
  if (!value) return "Usage";
  return value
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function transactionActivityTitle(type: CreditTransaction["type"]): string {
  switch (type) {
    case "grant":
      return "Credits added";
    case "refund":
      return "Refund";
    case "expire":
      return "Credits expired";
    case "revoke":
      return "Credits revoked";
    case "adjust":
      return "Balance adjusted";
    default:
      return "Balance activity";
  }
}

function transactionActivityAmountUsd(transaction: CreditTransaction): number {
  const amountUsd = amountToUsd(transaction.amount, transaction.token_type);
  switch (transaction.type) {
    case "consume":
    case "expire":
    case "revoke":
      return -amountUsd;
    case "grant":
    case "refund":
    case "adjust":
      return amountUsd;
    case "settlement":
      return 0;
    default:
      return amountUsd;
  }
}

function mapTransactionActivity(
  transaction: CreditTransaction,
): BillingBalanceActivity | null {
  if (transaction.type === "consume" || transaction.type === "settlement") {
    return null;
  }
  const amountUsd = transactionActivityAmountUsd(transaction);
  if (amountUsd === 0) return null;
  return {
    id: `transaction:${transaction.id}`,
    kind: transaction.type,
    tokenType: transaction.token_type,
    title: transactionActivityTitle(transaction.type),
    description: transaction.reason ?? transaction.source_type ?? null,
    sourceType: transaction.source_type ?? null,
    sourceId: transaction.source_id ?? null,
    operationId: transaction.operation_id ?? null,
    amountUsd,
    status: null,
    createdAt: transaction.created_at,
  };
}

function getUsageActivityDraft(
  drafts: Map<string, UsageActivityDraft>,
  input: {
    id: string;
    tokenType: string;
    usageType: string | null;
    sourceType: string | null;
    sourceId: string | null;
    operationId: string | null;
    reason: string | null;
    createdAt: string;
  },
): UsageActivityDraft {
  const key = input.operationId ? `operation:${input.operationId}` : input.id;
  const existing = drafts.get(key);
  if (existing) {
    if (new Date(input.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      existing.createdAt = input.createdAt;
    }
    existing.usageType ??= input.usageType;
    existing.sourceType ??= input.sourceType;
    existing.sourceId ??= input.sourceId;
    existing.reason ??= input.reason;
    return existing;
  }
  const draft: UsageActivityDraft = {
    id: key,
    tokenType: input.tokenType,
    usageType: input.usageType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    operationId: input.operationId,
    reason: input.reason,
    createdAt: input.createdAt,
    coveredAmountUsd: 0,
    overageAmountUsd: 0,
  };
  drafts.set(key, draft);
  return draft;
}

function mapUsageActivity(draft: UsageActivityDraft): BillingBalanceActivity | null {
  const totalAmountUsd = roundUsd(draft.coveredAmountUsd + draft.overageAmountUsd);
  if (totalAmountUsd <= 0) return null;
  const hasCovered = draft.coveredAmountUsd > 0;
  const hasOverage = draft.overageAmountUsd > 0;
  return {
    id: `usage:${draft.id}`,
    kind: "usage",
    tokenType: draft.tokenType,
    title: formatBillingLabel(draft.usageType),
    description: draft.reason ?? draft.sourceType,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    operationId: draft.operationId,
    amountUsd: -totalAmountUsd,
    status: hasCovered && hasOverage ? "partial" : hasOverage ? "overage" : "covered",
    createdAt: draft.createdAt,
  };
}

function addUsageTransactionDraft(
  drafts: Map<string, UsageActivityDraft>,
  transaction: CreditTransaction,
): void {
  const draft = getUsageActivityDraft(drafts, {
    id: `transaction:${transaction.id}`,
    tokenType: transaction.token_type,
    usageType: transaction.usage_type ?? null,
    sourceType: transaction.source_type ?? null,
    sourceId: transaction.source_id ?? null,
    operationId: transaction.operation_id ?? null,
    reason: transaction.reason ?? null,
    createdAt: transaction.created_at,
  });
  draft.coveredAmountUsd = roundUsd(
    draft.coveredAmountUsd + amountToUsd(transaction.amount, transaction.token_type),
  );
}

function addUsageOverageDraft(
  drafts: Map<string, UsageActivityDraft>,
  overage: UsageOverage,
): void {
  const draft = getUsageActivityDraft(drafts, {
    id: `overage:${overage.id}`,
    tokenType: overage.token_type,
    usageType: overage.usage_type ?? null,
    sourceType: overage.source_type,
    sourceId: overage.source_id,
    operationId: overage.operation_id,
    reason: overage.reason ?? null,
    createdAt: overage.created_at,
  });
  draft.overageAmountUsd = roundUsd(
    draft.overageAmountUsd + amountToUsd(overage.original_amount, overage.token_type),
  );
}

function buildBalanceActivities(input: {
  transactions: CreditTransaction[];
  overages: UsageOverage[];
}): BillingBalanceActivity[] {
  const usageDrafts = new Map<string, UsageActivityDraft>();
  const activities: BillingBalanceActivity[] = [];
  for (const transaction of input.transactions) {
    if (transaction.type === "consume") {
      addUsageTransactionDraft(usageDrafts, transaction);
      continue;
    }
    const activity = mapTransactionActivity(transaction);
    if (activity) activities.push(activity);
  }
  for (const overage of input.overages) {
    addUsageOverageDraft(usageDrafts, overage);
  }
  for (const draft of usageDrafts.values()) {
    const activity = mapUsageActivity(draft);
    if (activity) activities.push(activity);
  }
  return activities.sort(balanceActivityCreatedAtDesc);
}

function minorAmountToUsd(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Number((amount / 100).toFixed(2));
}

function normalizeBillingPage(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? 1));
}

function normalizeBillingLimit(value: number | undefined): number {
  return Math.min(10, Math.max(1, Math.floor(value ?? 10)));
}

function billingApiError(
  statusCode: number,
  message: string,
  code?: string,
): ApiError {
  return new ApiError({
    status: statusCode,
    message,
    code,
    responseBody: { message, code },
  });
}

function getCheckoutUnavailableReason(
  checkout: SubscriptionCheckout | undefined,
): string | null {
  if (isCheckoutUsable(checkout)) return null;
  return checkout?.message ?? null;
}

function isCheckoutUsable(
  checkout: SubscriptionCheckout | OrderCheckout | undefined,
): boolean {
  return (
    checkout?.checkout_usable === true &&
    Boolean(checkout.checkout_url || checkout.checkout_client_secret)
  );
}

function isCheckoutPayable(
  checkout: SubscriptionCheckout | OrderCheckout | undefined,
): boolean {
  return (
    isCheckoutUsable(checkout) ||
    (checkout?.checkout_usable === true &&
      checkout.checkout_ui_mode === "embedded_page")
  );
}

function isProviderBackedSubscriptionCheckout(
  checkout: SubscriptionCheckout | undefined,
): boolean {
  return optionalString(checkout?.provider_key) !== null;
}

function activeProviderKeyFromCheckout(
  checkout: SubscriptionCheckout | OrderCheckout | undefined,
): BillingActivePaymentProviderKey {
  return checkout?.provider_key === "stripe" || checkout?.provider_key === "waffo"
    ? checkout.provider_key
    : "not_configured";
}

function availableProviderKeysFromCheckout(
  checkout: SubscriptionCheckout | OrderCheckout | undefined,
): BillingPaymentProviderKey[] {
  const providerKey = activeProviderKeyFromCheckout(checkout);
  return providerKey === "not_configured" ? [] : [providerKey];
}

function mapSubscriptionHistoryStatus(
  subscription: Subscription,
  checkout?: SubscriptionCheckout,
): BillingSubscriptionHistoryStatus {
  const providerStatus =
    checkout?.subscription_status ?? checkout?.provider_request_status ?? null;
  const canPay =
    subscription.status === "pending_checkout" &&
    isCheckoutPayable(checkout);
  const canCancelAutoRenew =
    BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
      subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
    ) &&
    subscription.cancel_at_period_end === false &&
    subscription.current_period_end !== null &&
    isProviderBackedSubscriptionCheckout(checkout);
  return {
    id: subscription.id,
    externalUserId: subscription.external_user_id,
    productKey: subscription.product_key_snapshot,
    productName: subscription.product_name_snapshot,
    status: subscription.status,
    amountMinor: subscription.amount_snapshot,
    amountUsd: minorAmountToUsd(subscription.amount_snapshot),
    paidAmountMinor: subscription.paid_amount_snapshot,
    paidAmountUsd: minorAmountToUsd(subscription.paid_amount_snapshot),
    currency: subscription.currency_snapshot,
    billingPeriod: subscription.billing_period_snapshot,
    billingIntervalCount: subscription.billing_interval_count_snapshot,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at,
    checkoutExpiresAt: subscription.checkout_expires_at,
    checkoutCanceledAt: subscription.checkout_canceled_at,
    checkoutExpiredAt: subscription.checkout_expired_at,
    paymentConflictedAt: subscription.payment_conflicted_at,
    endedAt: subscription.ended_at,
    createdAt: subscription.created_at,
    updatedAt: subscription.updated_at,
    providerStatus,
    providerTerminal: false,
    checkoutStatus: checkout?.status ?? null,
    actions: {
      canPay,
      checkoutUrl: canPay ? (checkout?.checkout_url ?? null) : null,
      checkoutClientSecret: canPay
        ? (checkout?.checkout_client_secret ?? null)
        : null,
      checkoutUiMode: checkout?.checkout_ui_mode ?? null,
      checkoutUsable: canPay,
      canCancelCheckout: subscription.status === "pending_checkout",
      canCancelAutoRenew,
      unavailableReason: canPay ? null : getCheckoutUnavailableReason(checkout),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function uniqueStringArray(value: unknown): string[] {
  return [
    ...new Set(
      stringArray(value)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function firstOptionalNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = optionalNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function firstOptionalString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = optionalString(value);
    if (string !== null) return string;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProductInterval(
  product: Product,
): BillingCatalogProduct["interval"] {
  if (product.billing_type === "one_time") return "one_time";
  if (
    product.billing_type !== "recurring" ||
    product.billing_period !== "month"
  )
    return "other";
  switch (product.billing_interval_count) {
    case 1:
      return "monthly";
    case 3:
      return "quarterly";
    case 12:
      return "yearly";
    default:
      return "other";
  }
}

function isCreditsBenefit(benefit: Benefit): benefit is CreditsBenefit {
  return benefit.type === "credits";
}

function isProductCreditsBenefit(
  product: Product,
  benefit: CreditsBenefit,
): boolean {
  const grantKind =
    product.billing_type === "recurring" ? "plan_period" : "purchased";
  if (benefit.config.grant_kind !== grantKind) return false;
  const meta = asRecord(product.meta) ?? {};
  const display = asRecord(meta.display) ?? {};
  const configuredKeys = uniqueStringArray(
    display.credit_benefit_keys ??
      display.creditBenefitKeys ??
      meta.credit_benefit_keys,
  );
  if (configuredKeys.length > 0) return configuredKeys.includes(benefit.key);
  const productKey = product.key.toLowerCase();
  const benefitKey = benefit.key.toLowerCase();
  const exactKeys = new Set([
    `${productKey}_credits`,
    `${productKey}_benefit`,
    `${productKey}_credits_benefit`,
  ]);
  if (exactKeys.has(benefitKey)) return true;
  return (
    benefitKey.startsWith(`${productKey}_`) && benefitKey.includes("credit")
  );
}

function mapProductCreditBenefit(
  product: Product,
  benefit: CreditsBenefit,
): BillingProductCreditBenefit {
  const cycleAmount = benefit.config.amount;
  const multiplier =
    benefit.config.grant_kind === "plan_period"
      ? Math.max(1, product.billing_interval_count)
      : 1;
  const periodAmount = cycleAmount * multiplier;
  return {
    key: benefit.key,
    name: benefit.name,
    tokenType: benefit.config.token_type,
    grantKind: benefit.config.grant_kind,
    scope: benefit.config.scope,
    cycleAmount,
    cycleAmountUsd: amountToUsd(cycleAmount, benefit.config.token_type),
    periodAmount,
    periodAmountUsd: amountToUsd(periodAmount, benefit.config.token_type),
    expiresInDays:
      "expires_in_days" in benefit.config
        ? (benefit.config.expires_in_days ?? null)
        : null,
  };
}

function mapMetaCreditBenefit(
  product: Product,
  record: Record<string, unknown>,
  index: number,
): BillingProductCreditBenefit | null {
  const config = asRecord(record.config) ?? {};
  const tokenType =
    firstOptionalString(
      record.tokenType,
      record.token_type,
      config.token_type,
    ) ?? "cohub_credit";
  const grantKind =
    firstOptionalString(
      record.grantKind,
      record.grant_kind,
      config.grant_kind,
    ) ?? (product.billing_type === "recurring" ? "plan_period" : "purchased");
  const scope =
    firstOptionalString(record.scope, config.scope) ??
    (product.billing_type === "recurring" ? "business" : "global");
  const cycleAmount = firstOptionalNumber(
    record.cycleAmount,
    record.cycle_amount,
    record.amount,
    config.amount,
  );
  const cycleAmountUsd = firstOptionalNumber(
    record.cycleAmountUsd,
    record.cycle_amount_usd,
    record.amountUsd,
    record.amount_usd,
    record.usageBalanceUsd,
    record.usage_balance_usd,
  );
  if (cycleAmount === null && cycleAmountUsd === null) return null;
  const multiplier =
    grantKind === "plan_period" ? Math.max(1, product.billing_interval_count) : 1;
  const resolvedCycleAmount = cycleAmount ?? 0;
  const resolvedCycleAmountUsd =
    cycleAmountUsd ?? amountToUsd(resolvedCycleAmount, tokenType);
  const periodAmount =
    firstOptionalNumber(record.periodAmount, record.period_amount) ??
    resolvedCycleAmount * multiplier;
  const periodAmountUsd =
    firstOptionalNumber(record.periodAmountUsd, record.period_amount_usd) ??
    resolvedCycleAmountUsd * multiplier;
  return {
    key:
      firstOptionalString(record.key, record.benefitKey, record.benefit_key) ??
      `${product.key}_credit_${index + 1}`,
    name: firstOptionalString(record.name) ?? "Usage balance",
    tokenType,
    grantKind,
    scope,
    cycleAmount: resolvedCycleAmount,
    cycleAmountUsd: resolvedCycleAmountUsd,
    periodAmount,
    periodAmountUsd,
    expiresInDays: firstOptionalNumber(
      record.expiresInDays,
      record.expires_in_days,
      config.expires_in_days,
    ),
  };
}

function mapProductMetaCreditBenefits(
  product: Product,
): BillingProductCreditBenefit[] {
  const meta = asRecord(product.meta) ?? {};
  const display = asRecord(meta.display) ?? {};
  return recordArray(
    meta.creditBenefits ??
      meta.credit_benefits ??
      display.creditBenefits ??
      display.credit_benefits,
  ).flatMap((record, index) => {
    const benefit = mapMetaCreditBenefit(product, record, index);
    return benefit ? [benefit] : [];
  });
}

function mapCatalogProduct(
  product: Product,
  defaultPlanProductKey: string | null,
  creditBenefits: CreditsBenefit[],
): BillingCatalogProduct {
  const meta = asRecord(product.meta) ?? {};
  const pricing = asRecord(meta.pricing) ?? {};
  const display = asRecord(meta.display) ?? {};
  const compareAtAmountMinor =
    optionalNumber(pricing.compare_at_amount_minor) ??
    optionalNumber(pricing.compare_at_amount) ??
    null;
  const configuredCreditBenefits = mapProductMetaCreditBenefits(product);
  const productCreditBenefits =
    configuredCreditBenefits.length > 0
      ? configuredCreditBenefits
      : creditBenefits
          .filter((benefit) => isProductCreditsBenefit(product, benefit))
          .map((benefit) => mapProductCreditBenefit(product, benefit));
  const creditsAmount =
    productCreditBenefits.length > 0
      ? productCreditBenefits.reduce(
          (sum, benefit) => sum + benefit.periodAmount,
          0,
        )
      : null;
  return {
    id: product.id,
    key: product.key,
    name: product.name,
    description: product.description,
    status: product.status,
    visibility: product.visibility,
    billingType: product.billing_type,
    billingPeriod: product.billing_period,
    billingIntervalCount: product.billing_interval_count,
    currency: product.currency,
    kind: product.billing_type === "recurring" ? "plan" : "addon",
    interval: getProductInterval(product),
    pricing: {
      amountMinor: product.amount,
      amountUsd: minorAmountToUsd(product.amount),
      compareAtAmountMinor,
      compareAtAmountUsd:
        compareAtAmountMinor === null
          ? null
          : minorAmountToUsd(compareAtAmountMinor),
      discountLabel: optionalString(pricing.discount_label),
      discountRate: optionalNumber(pricing.discount_rate),
    },
    display: {
      description: optionalString(display.description) ?? product.description,
      benefits: stringArray(display.benefits),
      creditsAmount,
      validity:
        optionalString(display.validity) ?? optionalString(meta.validity),
      creditBenefits: productCreditBenefits,
    },
    isDefaultPlan: product.key === defaultPlanProductKey,
  };
}

function mapSubscriptionSummary(subscription: Subscription) {
  return {
    id: subscription.id,
    productKey: subscription.product_key_snapshot ?? null,
    productName: subscription.product_name_snapshot ?? null,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

function isSubscriptionExpiredAfterCancel(
  subscription: Subscription,
  now = new Date(),
): boolean {
  if (!subscription.cancel_at_period_end || !subscription.current_period_end)
    return false;
  const currentPeriodEnd = Date.parse(subscription.current_period_end);
  return !Number.isNaN(currentPeriodEnd) && currentPeriodEnd <= now.getTime();
}

async function resolvePaymentStatus(sdk: ConfiguredBillingSdk): Promise<BillingPaymentStatus> {
  try {
    const response = await sdk.admin.providers.status();
    const availableProviderKeys = response.providers
      .filter((provider) => provider.checkout_available)
      .map((provider) => provider.provider_key);
    if (response.status !== "available" || !response.checkout_available) {
      return {
        available: false,
        reason:
          response.active_provider_key === "not_configured"
            ? "No active payment provider"
            : "Checkout is currently unavailable",
        activeProviderKey: response.active_provider_key,
        availableProviderKeys,
      };
    }
    return {
      available: true,
      reason: null,
      activeProviderKey: response.active_provider_key,
      availableProviderKeys,
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : "Provider status query failed",
      activeProviderKey: "not_configured",
      availableProviderKeys: [],
    };
  }
}

type BillingStaticCatalogCache = {
  publicProducts: Product[];
  creditBenefits: CreditsBenefit[];
  defaultPlanProduct: Product | null;
  payment: BillingPaymentStatus;
};

async function readBillingCache<T>(key: string): Promise<T | null> {
  const redis = checkoutLockRedis;
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeBillingCache<T>(key: string, value: T, ttlSeconds: number) {
  const redis = checkoutLockRedis;
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Billing must keep working when Redis is unavailable.
  }
}

async function getBillingCache<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cached = await readBillingCache<T>(key);
  if (cached !== null) return cached;
  const value = await load();
  await writeBillingCache(key, value, ttlSeconds);
  return value;
}

function checkoutResultFromOrder(input: {
  userId: string;
  productKey: string;
  response: CreateOrderResponse;
  status: BillingPluginStatus;
  reused?: boolean;
}): BillingCheckoutResult {
  const checkout = input.response.checkout;
  const checkoutUsable = isCheckoutUsable(checkout);
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: checkoutUsable,
      reason: checkoutUsable
        ? null
        : (checkout?.message ?? "Checkout is not currently usable"),
      activeProviderKey: activeProviderKeyFromCheckout(checkout),
      availableProviderKeys: availableProviderKeysFromCheckout(checkout),
    },
    productKey: input.productKey,
    checkoutUrl: checkout?.checkout_url ?? null,
    checkoutClientSecret: checkout?.checkout_client_secret ?? null,
    checkoutUiMode: checkout?.checkout_ui_mode ?? null,
    checkoutUsable,
    message: checkout?.message ?? null,
    orderId: input.response.order.id,
    subscriptionId: input.response.order.subscription_id,
    reused: input.reused === true,
  };
}

function checkoutResultFromSubscription(input: {
  userId: string;
  productKey: string;
  response: CreateSubscriptionResponse;
  status: BillingPluginStatus;
}): BillingCheckoutResult {
  const checkout = input.response.checkout;
  const checkoutUsable = isCheckoutUsable(checkout);
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: checkoutUsable,
      reason: checkoutUsable
        ? null
        : (checkout?.message ?? "Checkout is not currently usable"),
      activeProviderKey: activeProviderKeyFromCheckout(checkout),
      availableProviderKeys: availableProviderKeysFromCheckout(checkout),
    },
    productKey: input.productKey,
    checkoutUrl: checkout?.checkout_url ?? null,
    checkoutClientSecret: checkout?.checkout_client_secret ?? null,
    checkoutUiMode: checkout?.checkout_ui_mode ?? null,
    checkoutUsable,
    message: checkout?.message ?? null,
    orderId: null,
    subscriptionId: input.response.subscription.id,
    reused: input.response.reused === true,
  };
}

function hostedCheckoutRedirects(returnUrl: string | undefined) {
  const resolved =
    returnUrl && /^https?:\/\//i.test(returnUrl) ? returnUrl : undefined;
  return {
    success_redirect_url: resolved,
    failed_redirect_url: resolved,
    cancel_redirect_url: resolved,
  };
}

function embeddedCheckoutRedirects(returnUrl: string | undefined) {
  const resolved =
    returnUrl && /^https?:\/\//i.test(returnUrl) ? returnUrl : undefined;
  return {
    checkout_ui_mode: "embedded_page" as const,
    checkout_return_url: resolved
      ? appendCheckoutSessionPlaceholder(resolved)
      : undefined,
    checkout_redirect_on_completion: "if_required" as const,
  };
}

function checkoutRedirectsForPaymentProvider(input: {
  payment: BillingPaymentStatus;
  returnUrl: string | undefined;
}) {
  return input.payment.activeProviderKey === "stripe"
    ? embeddedCheckoutRedirects(input.returnUrl)
    : hostedCheckoutRedirects(input.returnUrl);
}

function isCheckoutForAvailableProvider(
  checkout: SubscriptionCheckout | OrderCheckout | undefined,
  payment: BillingPaymentStatus,
) {
  const providerKey = activeProviderKeyFromCheckout(checkout);
  return providerKey !== "not_configured" && payment.availableProviderKeys.includes(providerKey);
}

function appendCheckoutSessionPlaceholder(urlString: string) {
  const url = new URL(urlString);
  url.searchParams.set("checkout_session_id", "{CHECKOUT_SESSION_ID}");
  return url
    .toString()
    .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
}

async function withRedisCheckoutLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockKey = `billing:checkout:lock:${key}`;
  const lockValue = randomUUID();
  const redis = checkoutLockRedis;
  if (!redis) return run();
  for (let attempt = 0; attempt < CHECKOUT_LOCK_RETRY_COUNT; attempt += 1) {
    const locked = await redis
      .set(lockKey, lockValue, "PX", CHECKOUT_LOCK_TTL_MS, "NX")
      .catch(() => null);
    if (locked === "OK") {
      try {
        return await run();
      } finally {
        await redis
          .eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            lockKey,
            lockValue,
          )
          .catch(() => undefined);
      }
    }
    await sleep(CHECKOUT_LOCK_RETRY_DELAY_MS);
  }
  return run();
}

function emptyCreditStatus(): BillingCreditStatus {
  return {
    netUsd: 0,
    groups: [],
  };
}

function emptyBalanceActivityList(input: {
  userId: string;
  tokenType: string;
  status: BillingPluginStatus;
  page: number;
  limit: number;
}): BillingBalanceActivityList {
  return {
    userId: input.userId,
    billing: input.status,
    tokenType: input.tokenType,
    unit: getCreditUnit(input.tokenType),
    page: input.page,
    limit: input.limit,
    items: [],
    pagination: {
      hasMore: false,
      nextPage: null,
    },
  };
}

function emptyCatalog(input: {
  userId: string;
  status: BillingPluginStatus;
  paymentReason: string | null;
}): BillingCatalog {
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: false,
      reason: input.paymentReason,
      activeProviderKey: "not_configured",
      availableProviderKeys: [],
    },
    products: [],
    plans: [],
    addons: [],
    currentSubscriptions: [],
    hasActiveSubscription: false,
    defaultPlanProductKey: null,
  };
}

function emptySubscriptionHistoryList(input: {
  userId: string;
  status: BillingPluginStatus;
  page: number;
  limit: number;
}): BillingSubscriptionHistoryList {
  return {
    userId: input.userId,
    billing: input.status,
    page: input.page,
    limit: input.limit,
    items: [],
    pagination: {
      hasMore: false,
      nextPage: null,
    },
  };
}

function disabledCheckoutResult(input: {
  userId: string;
  productKey: string;
  status: BillingPluginStatus;
  reason: string | null;
}): BillingCheckoutResult {
  return {
    userId: input.userId,
    billing: input.status,
    payment: {
      available: false,
      reason: input.reason,
      activeProviderKey: "not_configured",
      availableProviderKeys: [],
    },
    productKey: input.productKey,
    checkoutUrl: null,
    checkoutClientSecret: null,
    checkoutUiMode: null,
    checkoutUsable: false,
    message: input.reason,
    orderId: null,
    subscriptionId: null,
    reused: false,
  };
}

function disabledRedemptionResult(input: {
  userId: string;
  status: BillingPluginStatus;
  reason: string | null;
}): BillingRedemptionResult {
  return {
    userId: input.userId,
    billing: input.status,
    redeemed: false,
    message: input.reason,
    redemptionRecordId: null,
    itemCount: 0,
  };
}

function checkFeatureLimitFromEntitlement(input: {
  entitlement: BillingFeatureEntitlement | null;
  quantity: number;
  metadataKey: string;
  fallbackLimit?: number;
  missingEntitlementPolicy?: "allow" | "deny";
}): BillingFeatureLimitCheck {
  const unlimited = input.entitlement?.metadata.unlimited === true;
  const rawLimit = input.entitlement?.metadata[input.metadataKey];
  const entitlementLimit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : null;
  const limit = unlimited
    ? null
    : (entitlementLimit ?? input.fallbackLimit ?? null);
  const allowed =
    input.entitlement === null && limit === null
      ? input.missingEntitlementPolicy !== "deny"
      : unlimited || (limit !== null && input.quantity <= limit);
  return {
    allowed,
    quantity: input.quantity,
    limit,
    unlimited,
    entitlement: input.entitlement,
  };
}

export function createDisabledBillingOperations(
  reason = "billing configuration is missing",
): BillingOperations {
  const status: BillingPluginStatus = {
    provider: "disabled",
    configured: false,
    reason,
  };
  return {
    status,

    async ensureCustomer(input: BillingUserRef): Promise<BillingUserRef> {
      return input;
    },

    async getState(input: BillingUserRef): Promise<BillingAccountState> {
      return { userId: input.userId, credits: [], entitlements: [] };
    },

    async getCreditStatus(): Promise<BillingCreditStatus> {
      return emptyCreditStatus();
    },

    async getCatalog(input?: BillingUserRef): Promise<BillingCatalog> {
      return emptyCatalog({
        userId: input?.userId ?? "anonymous",
        status,
        paymentReason: status.reason ?? "Billing integration is not configured",
      });
    },

    async listSubscriptions(
      input: BillingHistoryListInput,
    ): Promise<BillingSubscriptionHistoryList> {
      return emptySubscriptionHistoryList({
        userId: input.userId,
        status,
        page: input.page ?? 1,
        limit: input.limit ?? 10,
      });
    },

    async purchaseAddon(
      input: BillingCheckoutInput,
    ): Promise<BillingCheckoutResult> {
      return disabledCheckoutResult({
        userId: input.userId,
        productKey: input.productKey,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async createSubscription(
      input: BillingCheckoutInput,
    ): Promise<BillingCheckoutResult> {
      return disabledCheckoutResult({
        userId: input.userId,
        productKey: input.productKey,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async recoverSubscriptionCheckout(): Promise<BillingCheckoutResult> {
      throw billingApiError(
        503,
        status.reason ?? "Billing integration is not configured",
        "billing_unavailable",
      );
    },

    async cancelSubscriptionCheckout(): Promise<BillingSubscriptionHistoryStatus> {
      throw billingApiError(
        503,
        status.reason ?? "Billing integration is not configured",
        "billing_unavailable",
      );
    },

    async cancelSubscriptionAutoRenew(): Promise<BillingSubscriptionHistoryStatus> {
      throw billingApiError(
        503,
        status.reason ?? "Billing integration is not configured",
        "billing_unavailable",
      );
    },

    async redeemCode(
      input: BillingRedemptionInput,
    ): Promise<BillingRedemptionResult> {
      return disabledRedemptionResult({
        userId: input.userId,
        status,
        reason: status.reason ?? "Billing integration is not configured",
      });
    },

    async preflightUsage(
      input: BillingUsagePreflightInput,
    ): Promise<BillingUsagePreflight> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return {
        allowed: true,
        tokenType,
        estimatedAmountUsd: roundUsd(
          input.estimatedAmountUsd,
          getCreditUnit(tokenType).usdDecimalPlaces,
        ),
        availableBalance: 0,
        netBalance: 0,
        shortfall: 0,
      };
    },

    async recordUsage(
      input: BillingUsageRecordInput,
    ): Promise<BillingUsageRecordResult> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return {
        tokenType,
        amountUsd: roundUsd(
          input.amountUsd,
          getCreditUnit(tokenType).usdDecimalPlaces,
        ),
        status: "disabled",
        response: null,
      };
    },

    async listBalanceActivities(
      input: BillingBalanceActivityListInput,
    ): Promise<BillingBalanceActivityList> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      return emptyBalanceActivityList({
        userId: input.userId,
        tokenType,
        status,
        page: input.page ?? 1,
        limit: input.limit ?? 10,
      });
    },

    async getFeatureEntitlement(): Promise<BillingFeatureEntitlement | null> {
      return null;
    },

    async checkFeatureLimit(
      input: BillingFeatureLimitInput,
    ): Promise<BillingFeatureLimitCheck> {
      const limit = input.fallbackLimit ?? null;
      const allowed =
        limit === null
          ? input.missingEntitlementPolicy !== "deny"
          : input.quantity <= limit;
      return {
        allowed,
        quantity: input.quantity,
        limit,
        unlimited: limit === null,
        entitlement: null,
      };
    },
  };
}

export function createTalesofaiBillingOperations(
  clientConfig: BillingClientConfig,
): BillingOperations {
  const sdk = createConfiguredSdk(clientConfig);
  const businessKey = clientConfig.businessKey;
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };
  const ensuredCustomers = new Map<
    string,
    { value: BillingUserRef; expiresAt: number }
  >();
  const inflightEnsures = new Map<string, Promise<BillingUserRef>>();
  const inflightCheckouts = new Map<string, Promise<BillingCheckoutResult>>();

  const runCheckoutSingleflight = (
    input: { kind: "addon" | "plan"; userId: string; productKey: string },
    run: () => Promise<BillingCheckoutResult>,
  ): Promise<BillingCheckoutResult> => {
    const key = `${businessKey}:${input.kind}:${input.userId}:${input.productKey}`;
    const inflight = inflightCheckouts.get(key);
    if (inflight) return inflight;
    const promise = withRedisCheckoutLock(key, run).finally(() => {
      inflightCheckouts.delete(key);
    });
    inflightCheckouts.set(key, promise);
    return promise;
  };

  const cacheEnsuredCustomer = (input: BillingUserRef) => {
    ensuredCustomers.set(input.userId, {
      value: input,
      expiresAt: Date.now() + ENSURE_CUSTOMER_CACHE_TTL_MS,
    });
  };

  const forgetEnsuredCustomer = (userId: string) => {
    ensuredCustomers.delete(userId);
  };

  const ensureCustomer = async (
    input: BillingUserRef,
  ): Promise<BillingUserRef> => {
    const cached = ensuredCustomers.get(input.userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const inflight = inflightEnsures.get(input.userId);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        const customer = await sdk.admin.customers.create({
          external_user_id: input.userId,
          status: "active",
        });
        const value = { userId: customer.external_user_id };
        cacheEnsuredCustomer(value);
        return value;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        const customer = await sdk.admin.customers.get({
          external_user_id: input.userId,
        });
        const value = { userId: customer.external_user_id };
        cacheEnsuredCustomer(value);
        return value;
      }
    })();

    inflightEnsures.set(input.userId, promise);
    try {
      return await promise;
    } finally {
      inflightEnsures.delete(input.userId);
    }
  };

  const getStateAfterEnsure = async (
    userId: string,
  ): Promise<BillingAccountState> => {
    await ensureCustomer({ userId });
    const state = await getCustomerStateOrEmpty({ sdk, businessKey, userId });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerStateOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        credits: [],
        entitlements: [],
      }
    );
  };

  const getCreditsAfterEnsure = async (
    userId: string,
  ): Promise<BillingUserRef & { credits: BillingCreditBalance[] }> => {
    await ensureCustomer({ userId });
    const state = await getCustomerCreditsOrEmpty({ sdk, businessKey, userId });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerCreditsOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        credits: [],
      }
    );
  };

  const getEntitlementsAfterEnsure = async (
    userId: string,
  ): Promise<
    BillingUserRef & { entitlements: BillingFeatureEntitlement[] }
  > => {
    await ensureCustomer({ userId });
    const state = await getCustomerEntitlementsOrEmpty({
      sdk,
      businessKey,
      userId,
    });
    if (state) return state;

    forgetEnsuredCustomer(userId);
    await ensureCustomer({ userId });
    return (
      (await getCustomerEntitlementsOrEmpty({ sdk, businessKey, userId })) ?? {
        userId,
        entitlements: [],
      }
    );
  };

  const getFeatureEntitlement = async (input: {
    userId: string;
    featureKey: string;
  }): Promise<BillingFeatureEntitlement | null> => {
    const state = await getEntitlementsAfterEnsure(input.userId);
    return (
      state.entitlements.find(
        (entitlement) =>
          entitlement.key === input.featureKey && entitlement.enabled,
      ) ?? null
    );
  };

  const listAllPages = async <T>(
    fetchPage: (page: number, limit: number) => Promise<BillingListPage<T>>,
  ): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; page <= CREDIT_LIST_MAX_PAGES; page += 1) {
      const response = await fetchPage(page, CREDIT_LIST_PAGE_LIMIT);
      items.push(...response.items);
      if (!response.pagination.has_more) break;
    }
    return items;
  };

  const listAllCreditGrants = async (input: {
    userId: string;
    tokenType: string;
    status?: CreditGrantDisplayStatus | "revoked";
  }): Promise<CreditGrant[]> =>
    listAllPages((page, limit) =>
      sdk.admin.credits.listGrants({
        business_key: businessKey,
        external_user_id: input.userId,
        token_type: input.tokenType,
        status: input.status,
        include_count: false,
        page,
        limit,
      }),
    );

  const listBalanceActivities = async (
    input: BillingBalanceActivityListInput,
  ): Promise<BillingBalanceActivityList> => {
    const tokenType = input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const limit = Math.min(10, Math.max(1, Math.floor(input.limit ?? 10)));
    await ensureCustomer({ userId: input.userId });
    const [transactions, overages] = await Promise.all([
      listAllPages((nextPage, nextLimit) =>
        sdk.admin.credits.listTransactions({
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          sorting: "-created_at",
          include_count: false,
          page: nextPage,
          limit: nextLimit,
        }),
      ),
      listAllPages((nextPage, nextLimit) =>
        sdk.admin.credits.listUsageOverages({
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          sorting: "-created_at",
          include_count: false,
          page: nextPage,
          limit: nextLimit,
        }),
      ),
    ]);
    const activities = buildBalanceActivities({ transactions, overages });
    const start = (page - 1) * limit;
    const items = activities.slice(start, start + limit);
    const hasMore = activities.length > start + limit;
    return {
      userId: input.userId,
      billing: status,
      tokenType,
      unit: getCreditUnit(tokenType),
      page,
      limit,
      items,
      pagination: {
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    };
  };

  const listPublicProducts = async (): Promise<Product[]> => {
    const products = await listAllPages((page, limit) =>
      sdk.admin.products.list({
        business_key: businessKey,
        include_count: false,
        page,
        limit,
      }),
    );
    return products.filter(
      (product) =>
        product.status === "active" && product.visibility === "public",
    );
  };

  const getProductOrNull = async (productKey: string): Promise<Product | null> => {
    try {
      return await sdk.admin.products.get({
        business_key: businessKey,
        product_key: productKey,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const appendReferencedSubscriptionProducts = async (input: {
    products: Product[];
    subscriptions: Subscription[];
  }): Promise<Product[]> => {
    const byKey = new Map(input.products.map((product) => [product.key, product]));
    const missingKeys = [...new Set(input.subscriptions
      .map((subscription) => subscription.product_key_snapshot)
      .filter((key): key is string => Boolean(key && !byKey.has(key))))];
    if (missingKeys.length === 0) return input.products;
    const referencedProducts = await Promise.all(missingKeys.map(getProductOrNull));
    for (const product of referencedProducts) {
      if (product?.status === "active") byKey.set(product.key, product);
    }
    return [...byKey.values()];
  };

  const listActiveCreditsBenefits = async (): Promise<CreditsBenefit[]> => {
    const benefits = await listAllPages((page, limit) =>
      sdk.admin.benefits.list({
        business_key: businessKey,
        include_count: false,
        page,
        limit,
      }),
    );
    return benefits.filter(
      (benefit): benefit is CreditsBenefit =>
        isCreditsBenefit(benefit) && benefit.status === "active",
    );
  };

  const getDefaultPlanProduct = async (): Promise<Product | null> => {
    try {
      const defaultPlan = await sdk.admin.businesses.getDefaultPlan({
        business_key: businessKey,
      });
      if (defaultPlan.status !== "enabled") return null;
      const products = await listAllPages((page, limit) =>
        sdk.admin.products.list({
          business_key: businessKey,
          include_count: false,
          page,
          limit,
        }),
      );
      return (
        products.find(
          (product) =>
            product.id === defaultPlan.product_id &&
            product.status === "active" &&
            product.billing_type === "recurring",
        ) ?? null
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const listSubscriptionsByStatuses = async (
    userId: string,
    statuses: readonly string[],
  ): Promise<Subscription[]> => {
    const subscriptions = await listAllPages((page, limit) =>
      sdk.admin.subscriptions.list({
        business_key: businessKey,
        external_user_id: userId,
        sorting: "-created_at",
        include_count: false,
        page,
        limit,
      }),
    );
    return subscriptions.filter((subscription) =>
      statuses.includes(subscription.status),
    );
  };

  const listCurrentSubscriptions = async (
    userId: string,
  ): Promise<Subscription[]> =>
    (
      await listSubscriptionsByStatuses(
        userId,
        BILLING_CURRENT_SUBSCRIPTION_STATUSES,
      )
    ).filter((subscription) => !isSubscriptionExpiredAfterCancel(subscription));

  const listBlockingSubscriptions = async (
    userId: string,
  ): Promise<Subscription[]> => {
    return (
      await listSubscriptionsByStatuses(
        userId,
        BILLING_BLOCKING_SUBSCRIPTION_STATUSES,
      )
    ).filter((subscription) => !isSubscriptionExpiredAfterCancel(subscription));
  };

  const getStaticCatalog = async (): Promise<BillingStaticCatalogCache> =>
    getBillingCache(
      `billing:catalog:static:${businessKey}:v1`,
      BILLING_STATIC_CATALOG_CACHE_TTL_SECONDS,
      async () => {
        const [publicProducts, creditBenefits, defaultPlanProduct, payment] = await Promise.all([
          listPublicProducts(),
          listActiveCreditsBenefits(),
          getDefaultPlanProduct(),
          resolvePaymentStatus(sdk),
        ]);
        return { publicProducts, creditBenefits, defaultPlanProduct, payment };
      },
    );

  const getCatalog = async (input?: BillingUserRef): Promise<BillingCatalog> => {
    const userId = input?.userId ?? "anonymous";
    if (input?.userId) await ensureCustomer({ userId: input.userId });
    const [
      staticCatalog,
      currentSubscriptions,
      blockingSubscriptions,
    ] = await Promise.all([
      getStaticCatalog(),
      input?.userId ? listCurrentSubscriptions(input.userId) : Promise.resolve([]),
      input?.userId ? listBlockingSubscriptions(input.userId) : Promise.resolve([]),
    ]);
    const { publicProducts, creditBenefits, defaultPlanProduct, payment } = staticCatalog;
    const hasActiveSubscription = blockingSubscriptions.some((subscription) =>
      BILLING_BLOCKING_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_BLOCKING_SUBSCRIPTION_STATUSES)[number],
      ),
    );
    const defaultPlanProductKey = input?.userId ? (defaultPlanProduct?.key ?? null) : null;
    const catalogProducts =
      input?.userId && defaultPlanProduct && !hasActiveSubscription
        ? [
            ...publicProducts.filter(
              (product) => product.key !== defaultPlanProduct.key,
            ),
            defaultPlanProduct,
          ]
        : publicProducts;
    const products = input?.userId
      ? await appendReferencedSubscriptionProducts({
          products: catalogProducts,
          subscriptions: [...currentSubscriptions, ...blockingSubscriptions],
        })
      : catalogProducts;
    const mappedProducts = products
      .map((product) =>
        mapCatalogProduct(product, defaultPlanProductKey, creditBenefits),
      )
      .sort(
        (left, right) => left.pricing.amountMinor - right.pricing.amountMinor,
      );
    const plans = mappedProducts.filter((product) => product.kind === "plan");
    const addons = mappedProducts.filter((product) => product.kind === "addon");
    return {
      userId,
      billing: status,
      payment,
      products: mappedProducts,
      plans,
      addons,
      currentSubscriptions: currentSubscriptions.map(mapSubscriptionSummary),
      hasActiveSubscription,
      defaultPlanProductKey,
    };
  };

  const findCheckoutProduct = async (input: {
    productKey: string;
    kind: "addon" | "plan";
  }): Promise<Product | null> => {
    try {
      const product = await sdk.admin.products.get({
        business_key: businessKey,
        product_key: input.productKey,
      });
      const expectedBillingType =
        input.kind === "addon" ? "one_time" : "recurring";
      if (
        product.status !== "active" ||
        product.visibility !== "public" ||
        product.billing_type !== expectedBillingType
      ) {
        return null;
      }
      return product;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }
  };

  const createUnavailableCheckout = (input: {
    userId: string;
    productKey: string;
    reason: string;
  }) =>
    disabledCheckoutResult({
      userId: input.userId,
      productKey: input.productKey,
      status,
      reason: input.reason,
    });

  const findReusableAddonCheckout = async (input: {
    userId: string;
    productKey: string;
    payment: BillingPaymentStatus;
  }): Promise<BillingCheckoutResult | null> => {
    const response = await sdk.admin.orders.list({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: input.productKey,
      status: "pending_checkout",
      billing_reason: "purchase",
      sorting: "-created_at",
      include_count: false,
      page: 1,
      limit: 10,
    });
    for (const order of response.items) {
      try {
        const inspected = await sdk.admin.orders.inspect({
          order_id: order.id,
          business_key: businessKey,
        });
        if (!isCheckoutForAvailableProvider(inspected.checkout, input.payment)) {
          continue;
        }
        if (
          inspected.checkout?.checkout_ui_mode === "embedded_page" &&
          inspected.checkout.checkout_usable === true &&
          !inspected.checkout.checkout_client_secret
        ) {
          const recovered = await sdk.admin.orders.recoverCheckoutClientSecret(
            { order_id: order.id },
            { business_key: businessKey },
          );
          return checkoutResultFromOrder({
            userId: input.userId,
            productKey: input.productKey,
            response: recovered,
            status,
            reused: true,
          });
        }
        if (isCheckoutUsable(inspected.checkout)) {
          return checkoutResultFromOrder({
            userId: input.userId,
            productKey: input.productKey,
            response: inspected,
            status,
            reused: true,
          });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  };

  const findReusableSubscriptionCheckout = async (input: {
    userId: string;
    productKey: string;
    payment: BillingPaymentStatus;
  }): Promise<BillingCheckoutResult | null> => {
    const response = await sdk.admin.subscriptions.list({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: input.productKey,
      status: "pending_checkout",
      sorting: "-created_at",
      include_count: false,
      page: 1,
      limit: 10,
    });
    for (const subscription of response.items) {
      try {
        const inspected = await sdk.admin.subscriptions.inspect({
          subscription_id: subscription.id,
          business_key: businessKey,
        });
        if (!isCheckoutForAvailableProvider(inspected.checkout, input.payment)) {
          continue;
        }
        if (
          inspected.checkout?.checkout_ui_mode === "embedded_page" &&
          inspected.checkout.checkout_usable === true &&
          !inspected.checkout.checkout_client_secret
        ) {
          const recovered =
            await sdk.admin.subscriptions.recoverCheckoutClientSecret(
              { subscription_id: subscription.id },
              { business_key: businessKey },
            );
          return checkoutResultFromSubscription({
            userId: input.userId,
            productKey: input.productKey,
            response: { ...recovered, reused: true },
            status,
          });
        }
        if (isCheckoutUsable(inspected.checkout)) {
          return checkoutResultFromSubscription({
            userId: input.userId,
            productKey: input.productKey,
            response: { ...inspected, reused: true },
            status,
          });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  };

  const purchaseAddon = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    return runCheckoutSingleflight(
      { kind: "addon", userId: input.userId, productKey: input.productKey },
      () => purchaseAddonUnprotected(input),
    );
  };

  const purchaseAddonUnprotected = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    const product = await findCheckoutProduct({
      productKey: input.productKey,
      kind: "addon",
    });
    if (!product) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: input.productKey,
        reason: "Product is not available for purchase",
      });
    }

    await ensureCustomer({ userId: input.userId });
    const payment = await resolvePaymentStatus(sdk);
    const reusableCheckout = await findReusableAddonCheckout({
      userId: input.userId,
      productKey: product.key,
      payment,
    });
    if (reusableCheckout) return reusableCheckout;

    if (!payment.available) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: payment.reason ?? "No available payment provider",
      });
    }

    const response = await sdk.admin.orders.create({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: product.key,
      billing_reason: "purchase",
      ...checkoutRedirectsForPaymentProvider({
        payment,
        returnUrl: input.returnUrl,
      }),
    });
    return checkoutResultFromOrder({
      userId: input.userId,
      productKey: product.key,
      response,
      status,
    });
  };

  const createSubscription = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    return runCheckoutSingleflight(
      { kind: "plan", userId: input.userId, productKey: input.productKey },
      () => createSubscriptionUnprotected(input),
    );
  };

  const createSubscriptionUnprotected = async (
    input: BillingCheckoutInput,
  ): Promise<BillingCheckoutResult> => {
    const product = await findCheckoutProduct({
      productKey: input.productKey,
      kind: "plan",
    });
    if (!product) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: input.productKey,
        reason: "Plan is not available for subscription",
      });
    }

    await ensureCustomer({ userId: input.userId });
    const payment = await resolvePaymentStatus(sdk);
    const currentSubscriptions = await listBlockingSubscriptions(input.userId);
    if (currentSubscriptions.length > 0) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: "A subscription is already active",
      });
    }

    const reusableCheckout = await findReusableSubscriptionCheckout({
      userId: input.userId,
      productKey: product.key,
      payment,
    });
    if (reusableCheckout) return reusableCheckout;

    if (!payment.available) {
      return createUnavailableCheckout({
        userId: input.userId,
        productKey: product.key,
        reason: payment.reason ?? "No available payment provider",
      });
    }

    const response = await sdk.admin.subscriptions.create({
      business_key: businessKey,
      external_user_id: input.userId,
      product_key: product.key,
      ...checkoutRedirectsForPaymentProvider({
        payment,
        returnUrl: input.returnUrl,
      }),
    });
    return checkoutResultFromSubscription({
      userId: input.userId,
      productKey: product.key,
      response,
      status,
    });
  };

  const shouldInspectSubscriptionForHistory = (
    subscription: Subscription,
  ): boolean => {
    if (subscription.status === "pending_checkout") return true;
    return (
      BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
      ) &&
      subscription.cancel_at_period_end === false &&
      subscription.current_period_end !== null
    );
  };

  const listSubscriptions = async (
    input: BillingHistoryListInput,
  ): Promise<BillingSubscriptionHistoryList> => {
    const page = normalizeBillingPage(input.page);
    const limit = normalizeBillingLimit(input.limit);
    await ensureCustomer({ userId: input.userId });
    const response = await sdk.admin.subscriptions.list({
      business_key: businessKey,
      external_user_id: input.userId,
      sorting: "-created_at",
      include_count: false,
      page,
      limit,
    });
    const items = await Promise.all(
      response.items.map(async (subscription) => {
        if (!shouldInspectSubscriptionForHistory(subscription)) {
          return mapSubscriptionHistoryStatus(subscription);
        }
        try {
          const inspected = await sdk.admin.subscriptions.inspect({
            subscription_id: subscription.id,
            business_key: businessKey,
          });
          return mapSubscriptionHistoryStatus(
            inspected.subscription,
            inspected.checkout,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          return mapSubscriptionHistoryStatus(subscription);
        }
      }),
    );
    const hasMore = response.pagination.has_more;
    return {
      userId: input.userId,
      billing: status,
      page,
      limit,
      items,
      pagination: {
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    };
  };

  const getOwnedSubscription = async (input: {
    userId: string;
    subscriptionId: string;
  }): Promise<Subscription> => {
    try {
      const subscription = await sdk.admin.subscriptions.get({
        subscription_id: input.subscriptionId,
        business_key: businessKey,
      });
      if (subscription.external_user_id !== input.userId) {
        throw billingApiError(
          404,
          "Subscription not found",
          "subscription_not_found",
        );
      }
      return subscription;
    } catch (error) {
      if (isNotFound(error))
        throw billingApiError(
          404,
          "Subscription not found",
          "subscription_not_found",
        );
      throw error;
    }
  };

  const cancelSubscriptionCheckout = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingSubscriptionHistoryStatus> => {
    const subscription = await getOwnedSubscription(input);
    if (subscription.status !== "pending_checkout") {
      throw billingApiError(
        409,
        "Only pending checkout subscriptions can be canceled",
        "subscription_checkout_not_cancelable",
      );
    }
    const canceled = await sdk.admin.subscriptions.cancelCheckout(
      { subscription_id: input.subscriptionId },
      { business_key: businessKey },
      {
        idempotencyKey: `cohub:billing:subscription-cancel-checkout:${input.userId}:${input.subscriptionId}`,
      },
    );
    return mapSubscriptionHistoryStatus(canceled);
  };

  const recoverSubscriptionCheckout = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingCheckoutResult> => {
    const subscription = await getOwnedSubscription(input);
    if (subscription.status !== "pending_checkout") {
      throw billingApiError(
        409,
        "Only pending checkout subscriptions can be recovered",
        "subscription_checkout_not_recoverable",
      );
    }

    const inspected = await sdk.admin.subscriptions.inspect({
      subscription_id: input.subscriptionId,
      business_key: businessKey,
    });
    const payment = await resolvePaymentStatus(sdk);
    if (!isCheckoutForAvailableProvider(inspected.checkout, payment)) {
      throw billingApiError(
        409,
        "Subscription checkout is not recoverable for the active payment provider",
        "subscription_checkout_provider_mismatch",
      );
    }
    const productKey = inspected.subscription.product_key_snapshot;
    if (
      inspected.checkout?.checkout_ui_mode === "embedded_page" &&
      inspected.checkout.checkout_usable === true &&
      !inspected.checkout.checkout_client_secret
    ) {
      const recovered = await sdk.admin.subscriptions.recoverCheckoutClientSecret(
        { subscription_id: input.subscriptionId },
        { business_key: businessKey },
      );
      return checkoutResultFromSubscription({
        userId: input.userId,
        productKey,
        response: { ...recovered, reused: true },
        status,
      });
    }
    if (isCheckoutUsable(inspected.checkout)) {
      return checkoutResultFromSubscription({
        userId: input.userId,
        productKey,
        response: { ...inspected, reused: true },
        status,
      });
    }

    throw billingApiError(
      409,
      "Subscription checkout is not recoverable",
      "subscription_checkout_not_recoverable",
    );
  };

  const cancelSubscriptionAutoRenew = async (
    input: BillingUserRef & { subscriptionId: string },
  ): Promise<BillingSubscriptionHistoryStatus> => {
    const subscription = await getOwnedSubscription(input);
    if (
      !BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES.includes(
        subscription.status as (typeof BILLING_AUTO_RENEW_CANCELABLE_SUBSCRIPTION_STATUSES)[number],
      ) ||
      subscription.cancel_at_period_end ||
      subscription.current_period_end === null
    ) {
      throw billingApiError(
        409,
        "Subscription auto-renew cannot be canceled",
        "subscription_auto_renew_not_cancelable",
      );
    }

    const inspected = await sdk.admin.subscriptions.inspect({
      subscription_id: input.subscriptionId,
      business_key: businessKey,
    });
    if (!isProviderBackedSubscriptionCheckout(inspected.checkout)) {
      throw billingApiError(
        409,
        "Subscription auto-renew cannot be canceled",
        "subscription_auto_renew_not_cancelable",
      );
    }
    const response = await sdk.admin.subscriptions.cancel(
      { subscription_id: input.subscriptionId },
      { business_key: businessKey },
      {
        idempotencyKey: `cohub:billing:subscription-cancel-auto-renew:${input.userId}:${input.subscriptionId}`,
      },
    );
    const cancellationCheckout = response.cancellation
      ? ({
          provider_key: response.cancellation.provider_key,
          provider_config_id: response.cancellation.provider_config_id,
          status: response.cancellation.status,
          message: response.cancellation.message,
          acquiring_subscription_id:
            response.cancellation.acquiring_subscription_id,
          subscription_status: response.cancellation.subscription_status,
        } satisfies SubscriptionCheckout)
      : inspected.checkout;
    return mapSubscriptionHistoryStatus(
      response.subscription,
      cancellationCheckout,
    );
  };

  const redeemCode = async (
    input: BillingRedemptionInput,
  ): Promise<BillingRedemptionResult> => {
    const code = normalizeRedemptionCode(input.code);
    if (!code) {
      return {
        userId: input.userId,
        billing: status,
        redeemed: false,
        message: "Redemption code is required",
        redemptionRecordId: null,
        itemCount: 0,
      };
    }
    await ensureCustomer({ userId: input.userId });
    const response = await sdk.admin.redemptionCodes.redeem(
      {
        code,
        external_user_id: input.userId,
      },
      {
        idempotencyKey: redemptionIdempotencyKey({
          userId: input.userId,
          code,
        }),
      },
    );
    return {
      userId: input.userId,
      billing: status,
      redeemed: true,
      message: null,
      redemptionRecordId: response.redemption_record.id,
      itemCount: response.redemption_record.items_snapshot.length,
    };
  };

  return {
    status,
    ensureCustomer,

    async getState(input: BillingUserRef): Promise<BillingAccountState> {
      return getStateAfterEnsure(input.userId);
    },

    async getCreditStatus(
      input: BillingUserRef & { tokenType?: string },
    ): Promise<BillingCreditStatus> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const state = await getCreditsAfterEnsure(input.userId);
      const balance = findBalance(state.credits, tokenType);
      const grants = (
        await listAllCreditGrants({ userId: input.userId, tokenType })
      ).filter(
        (grant) =>
          CREDIT_GRANT_DISPLAY_STATUSES.includes(
            grant.status as CreditGrantDisplayStatus,
          ) && isCreditGrantDisplayable(grant),
      );
      const grantStatuses = grants.map((grant) => mapCreditGrant(grant));
      const openOverageUsd = amountToUsd(
        balance?.openOverageBalance ?? 0,
        tokenType,
      );
      const netUsd = balance
        ? amountToUsd(balance.netBalance, tokenType)
        : -openOverageUsd;

      return {
        netUsd,
        groups: groupCreditGrants(grantStatuses),
      };
    },

    getCatalog,

    listSubscriptions,

    purchaseAddon,

    createSubscription,

    recoverSubscriptionCheckout,

    cancelSubscriptionCheckout,

    cancelSubscriptionAutoRenew,

    redeemCode,

    async preflightUsage(
      input: BillingUsagePreflightInput,
    ): Promise<BillingUsagePreflight> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const estimatedAmountUsd = roundUsd(
        input.estimatedAmountUsd,
        getCreditUnit(tokenType).usdDecimalPlaces,
      );
      const estimatedAmount = usdToAmount(estimatedAmountUsd, tokenType);
      if (estimatedAmountUsd === 0) {
        return {
          allowed: true,
          tokenType,
          estimatedAmountUsd,
          availableBalance: 0,
          netBalance: 0,
          shortfall: 0,
        };
      }

      await ensureCustomer({ userId: input.userId });
      const preview = await sdk.admin.credits.previewConsume({
        business_key: businessKey,
        external_user_id: input.userId,
        token_type: tokenType,
        amount: estimatedAmount,
        source_type: "usage",
        source_id: `preflight:${input.usageType}`,
        usage_type: input.usageType,
      });
      const availableBalance = amountToUsd(preview.available_before, tokenType);
      const netBalance = amountToUsd(
        Math.max(
          0,
          preview.available_before -
            preview.historical_overage_settlement_amount,
        ),
        tokenType,
      );
      const shortfall = amountToUsd(
        preview.uncovered_current_usage_amount,
        tokenType,
      );
      return {
        allowed:
          !preview.would_create_overage &&
          preview.uncovered_current_usage_amount === 0,
        tokenType,
        estimatedAmountUsd,
        availableBalance,
        netBalance,
        shortfall,
      };
    },

    async recordUsage(
      input: BillingUsageRecordInput,
    ): Promise<BillingUsageRecordResult> {
      const tokenType =
        input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
      const amountUsd = roundUsd(
        input.amountUsd,
        getCreditUnit(tokenType).usdDecimalPlaces,
      );
      const amount = usdToAmount(amountUsd, tokenType);
      if (amount === 0) {
        return { tokenType, amountUsd, status: "skipped", response: null };
      }

      await ensureCustomer({ userId: input.userId });
      const response = await sdk.admin.credits.consume(
        {
          business_key: businessKey,
          external_user_id: input.userId,
          token_type: tokenType,
          amount,
          source_type: "usage",
          source_id: input.sourceId,
          usage_type: input.usageType,
          operation_id: input.operationId,
          reason: input.reason,
        },
        { idempotencyKey: input.operationId },
      );

      return {
        tokenType,
        amountUsd,
        status: response.overage ? "overage" : "recorded",
        response,
      };
    },

    listBalanceActivities,

    getFeatureEntitlement,

    async checkFeatureLimit(
      input: BillingFeatureLimitInput,
    ): Promise<BillingFeatureLimitCheck> {
      const entitlement = await getFeatureEntitlement(input);
      return checkFeatureLimitFromEntitlement({
        entitlement,
        quantity: input.quantity,
        metadataKey: input.metadataKey ?? "limit",
        fallbackLimit: input.fallbackLimit,
        missingEntitlementPolicy: input.missingEntitlementPolicy,
      });
    },
  };
}

function createBusinessSdk(clientConfig: BillingClientConfig) {
  return createSdk({
    baseURL: clientConfig.baseUrl,
    adminApiKey: clientConfig.adminApiKey,
  })
    .useAdmin(customersFeature())
    .useAdmin(creditsFeature());
}

type BusinessSdk = ReturnType<typeof createBusinessSdk>;

async function ensureBusinessCustomer(
  sdk: BusinessSdk,
  businessKey: string,
  userId: string,
): Promise<void> {
  try {
    await sdk.admin.customers.create({
      external_user_id: userId,
      status: "active",
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
  }
}

async function listBusinessCreditGrants(
  sdk: BusinessSdk,
  businessKey: string,
  userId: string,
): Promise<CreditGrant[]> {
  const grants: CreditGrant[] = [];
  for (let page = 1; page <= CREDIT_LIST_MAX_PAGES; page += 1) {
    const result = await sdk.admin.credits.listGrants({
      business_key: businessKey,
      external_user_id: userId,
      token_type: COHUB_BILLING_TOKEN_TYPES.cohubCredit,
      include_count: false,
      page,
      limit: CREDIT_LIST_PAGE_LIMIT,
    });
    grants.push(...result.items);
    if (!result.pagination.has_more) break;
  }
  return grants;
}

async function resolveRemaining(
  sdk: BusinessSdk,
  businessKey: string,
  userId: string,
): Promise<number> {
  try {
    const credits = await sdk.admin.customers.getCredits({
      external_user_id: userId,
      business_key: businessKey,
    });
    const balance =
      credits.credits.find((c) => c.token_type === COHUB_BILLING_TOKEN_TYPES.cohubCredit) ?? null;
    return balance?.available_balance ?? 0;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return 0;
  }
}

/**
 * Creates business-scoped billing operations bound to a single billing
 * business (e.g. a Cohub Space). Shares the platform credit mapping helpers
 * and declarations so space commerce and platform billing never drift apart.
 * Credits use the virtual `cohub_credit` token at business scope.
 */
export function createBusinessBillingOperations(input: {
  clientConfig: BillingClientConfig;
  businessKey: string;
}): BusinessBillingOperations {
  const sdk = createBusinessSdk(input.clientConfig);
  const businessKey = input.businessKey;
  const status: BillingPluginStatus = {
    provider: "talesofai",
    configured: true,
  };

  const getEntitlements = async (
    ref: BillingUserRef,
  ): Promise<BillingAccountState> => {
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);
    try {
      const state = await sdk.admin.customers.getState({
        external_user_id: ref.userId,
        business_key: businessKey,
      });
      return {
        userId: ref.userId,
        credits: state.credits.map(mapCreditBalance),
        entitlements: mapFeatureEntitlements(state.active_benefits),
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return { userId: ref.userId, credits: [], entitlements: [] };
    }
  };

  const getCreditStatus = async (
    ref: BillingUserRef,
  ): Promise<BillingCreditStatus> => {
    const tokenType = COHUB_BILLING_TOKEN_TYPES.cohubCredit;
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);
    let netBalance = 0;
    try {
      const credits = await sdk.admin.customers.getCredits({
        external_user_id: ref.userId,
        business_key: businessKey,
      });
      const balance =
        credits.credits.find((c) => c.token_type === tokenType) ?? null;
      netBalance = balance?.net_balance ?? 0;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const grants = (await listBusinessCreditGrants(sdk, businessKey, ref.userId)).filter(
      (grant) =>
        CREDIT_GRANT_DISPLAY_STATUSES.includes(
          grant.status as CreditGrantDisplayStatus,
        ) && isCreditGrantDisplayable(grant),
    );
    const grantStatuses = grants.map((grant) => mapCreditGrant(grant));
    return {
      netUsd: amountToUsd(netBalance, tokenType),
      groups: groupCreditGrants(grantStatuses),
    };
  };

  const consume = async (
    ref: BillingUserRef & {
      amount: number;
      operationId: string;
      sourceId: string;
      reason?: string;
    },
  ): Promise<BusinessCreditConsumeResult> => {
    const tokenType = COHUB_BILLING_TOKEN_TYPES.cohubCredit;
    const amount = Math.max(0, Math.floor(ref.amount));
    if (amount <= 0) {
      return { userId: ref.userId, status: "consumed", amount: 0, remaining: 0, shortfall: null };
    }
    await ensureBusinessCustomer(sdk, businessKey, ref.userId);

    // Consume is authoritative and idempotent via operationId: a retry returns
    // the original result without double-charging.
    const response = await sdk.admin.credits.consume(
      {
        business_key: businessKey,
        external_user_id: ref.userId,
        token_type: tokenType,
        amount,
        source_type: "usage",
        source_id: ref.sourceId,
        usage_type: COHUB_BILLING_USAGE_TYPES.workConsumption,
        operation_id: ref.operationId,
        reason: ref.reason,
      },
      { idempotencyKey: ref.operationId },
    );

    const remaining = await resolveRemaining(sdk, businessKey, ref.userId);

    if (response.overage) {
      return {
        userId: ref.userId,
        status: "insufficient",
        amount: 0,
        remaining,
        shortfall: amount,
      };
    }

    return {
      userId: ref.userId,
      status: "consumed",
      amount,
      remaining,
      shortfall: null,
    };
  };

  return {
    status,
    businessKey,
    getEntitlements,
    getCreditStatus,
    consume,
  };
}

export function createDisabledBusinessBillingOperations(
  reason = "billing configuration is missing",
): BusinessBillingOperations {
  const status: BillingPluginStatus = {
    provider: "disabled",
    configured: false,
    reason,
  };
  return {
    status,
    businessKey: "",
    async getEntitlements(input: BillingUserRef): Promise<BillingAccountState> {
      return { userId: input.userId, credits: [], entitlements: [] };
    },
    async getCreditStatus(): Promise<BillingCreditStatus> {
      return emptyCreditStatus();
    },
    async consume(input): Promise<BusinessCreditConsumeResult> {
      return {
        userId: input.userId,
        status: "disabled",
        amount: 0,
        remaining: 0,
        shortfall: null,
      };
    },
  };
}

let defaultBillingOperations: BillingOperations | null = null;

export function createBillingOperations(): BillingOperations {
  const clientConfig = resolveBillingClientConfig();
  return clientConfig
    ? createTalesofaiBillingOperations(clientConfig)
    : createDisabledBillingOperations();
}

export function getBillingOperations(): BillingOperations {
  defaultBillingOperations ??= createBillingOperations();
  return defaultBillingOperations;
}

export const billingOperations = new Proxy({} as BillingOperations, {
  get(_target, property, receiver) {
    return Reflect.get(getBillingOperations(), property, receiver);
  },
});
