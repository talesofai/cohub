import type { Context } from "hono";
import { isBillingApiError } from "./billing-api-error.js";
import { FEATURE_NOT_ENTITLED_ERROR_CODE } from "@cohub/billing";
import { featureGateResponse } from "./feature-gate.js";
import { jsonError } from "./json-error.js";
import { SpaceCommerceNotInitializedError, resolveSpaceCommerceEntitlement } from "./space-commerce.js";
import type { AuthUser } from "./middleware.js";
import { resolveBillingUserId } from "../identity-bridge.js";

export const SPACE_COMMERCE_NOT_INITIALIZED_CODE = "space_commerce_not_initialized";
export const SPACE_COMMERCE_ENTITLEMENT_REQUIRED_CODE = FEATURE_NOT_ENTITLED_ERROR_CODE;
export const SPACE_COMMERCE_ENTITLEMENT_UNAVAILABLE_CODE = "space_commerce_unavailable";

function commerceApiErrorResponse(c: Context, error: { status: number; message: string }, input: { conflictMessage: string }) {
  const status = error.status >= 500 ? 502 : error.status;
  const message =
    status === 400 ? "Invalid commerce request" :
    status === 401 ? "Unauthorized" :
    status === 403 ? "Forbidden" :
    status === 404 ? "Commerce resource not found" :
    status === 409 ? input.conflictMessage :
    "Commerce request failed";
  return jsonError(c, { status, message });
}

export function handleSpaceCommerceRouteError(c: Context, error: unknown) {
  if (isBillingApiError(error)) {
    return commerceApiErrorResponse(c, error, { conflictMessage: "Commerce request conflicted" });
  }
  if (error instanceof SpaceCommerceNotInitializedError) {
    return jsonError(c, {
      status: 409,
      message: "Space commerce is not initialized",
      code: SPACE_COMMERCE_NOT_INITIALIZED_CODE,
    });
  }
  return null;
}

export function handleWorkCommerceRouteError(c: Context, error: unknown) {
  if (isBillingApiError(error)) {
    return commerceApiErrorResponse(c, error, { conflictMessage: "Checkout is not available" });
  }
  if (error instanceof SpaceCommerceNotInitializedError) {
    return jsonError(c, {
      status: 409,
      message: "Commerce is not available for this work yet",
      code: SPACE_COMMERCE_NOT_INITIALIZED_CODE,
    });
  }
  return null;
}

/**
 * Guards commerce management routes behind the `space.commerce` entitlement.
 * Returns `null` when the user is entitled. Returns 503 when entitlement
 * could not be verified (transient billing failure), and 402 with a billing
 * conversion intent when the user is explicitly not entitled so the shared
 * upgrade UI can pick it up.
 */
export async function requireSpaceCommerceEntitlement(
  c: Context,
  user: AuthUser,
): Promise<Response | null> {
  const userId = await resolveBillingUserId(user).catch(() => null);
  if (!userId) {
    return jsonError(c, {
      status: 503,
      message: "Could not verify billing identity. Please try again.",
      code: SPACE_COMMERCE_ENTITLEMENT_UNAVAILABLE_CODE,
    });
  }
  const entitled = await resolveSpaceCommerceEntitlement(userId);
  if (entitled === null) {
    return jsonError(c, {
      status: 503,
      message: "Could not verify plan eligibility. Please try again.",
      code: SPACE_COMMERCE_ENTITLEMENT_UNAVAILABLE_CODE,
    });
  }
  if (entitled) return null;
  return featureGateResponse(c, {
    source: "space_commerce",
    message: "Managing space commerce requires a Max plan.",
    title: "Upgrade to Max",
    conversionMessage: "Managing space commerce requires a Max plan.",
  });
}
