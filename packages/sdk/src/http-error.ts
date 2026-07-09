import { HttpError } from "./transport.js";
import type { BillingResponsePayload } from "./types.js";

/** Shared HTTP error code for every plan entitlement gate (402). */
export const FEATURE_NOT_ENTITLED_ERROR_CODE = "feature_not_entitled" as const;

/** Shared HTTP error code for a blocked usage gate (negative balance limit, 402). */
export const BILLING_ACCESS_BLOCKED_ERROR_CODE = "billing_credit_limit_exceeded" as const;

export function isHttpErrorCode(error: unknown, code: string): error is HttpError & { code: string } {
  return error instanceof HttpError && error.code === code;
}

export function isFeatureNotEntitledError(error: unknown): error is HttpError & { code: string } {
  return isHttpErrorCode(error, FEATURE_NOT_ENTITLED_ERROR_CODE);
}

export function isBillingAccessBlockedError(error: unknown): error is HttpError & { code: string } {
  return isHttpErrorCode(error, BILLING_ACCESS_BLOCKED_ERROR_CODE);
}

export function isBillingAccessBlockedCode(code: string | null | undefined): boolean {
  return code === BILLING_ACCESS_BLOCKED_ERROR_CODE;
}

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  !!value && typeof value === "object" && !Array.isArray(value);

function isBillingConversionIntent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.level === "soft" || value.level === "hard") &&
    typeof value.title === "string" &&
    typeof value.message === "string" &&
    isRecord(value.primaryAction) &&
    value.primaryAction.action === "open_billing_conversion"
  );
}

/**
 * Extracts the standard `billing` payload from a response body, an
 * `HttpError`, or a bare billing payload (e.g. a realtime error event's
 * `billing` field). Returns `null` unless it carries a valid conversion
 * intent.
 */
export function extractBillingPayload(source: unknown): BillingResponsePayload | null {
  const root = source instanceof HttpError ? source.body : source;
  if (!isRecord(root)) return null;
  const billing = isRecord(root.billing) ? root.billing : root;
  if (!isBillingConversionIntent(billing.conversion)) return null;
  return billing as unknown as BillingResponsePayload;
}
