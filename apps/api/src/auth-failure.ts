import { AuthorizationError } from "@cohub/identity";

export type UserAccessTokenFailureReason =
  | "jwt_expired"
  | "jwt_not_active"
  | "jwt_issuer_mismatch"
  | "jwt_audience_mismatch"
  | "jwt_signature_invalid"
  | "jwt_signing_key_not_found"
  | "jwt_signing_key_ambiguous"
  | "jwks_invalid"
  | "jwks_timeout"
  | "jwks_unavailable"
  | "jwt_algorithm_not_allowed"
  | "jwt_malformed"
  | "jwt_claim_invalid"
  | "missing_subject"
  | "third_party_access_denied"
  | "missing_client_id"
  | "missing_user_id"
  | "jwt_verification_failed"
  | "unknown";

export type UserAccessTokenFailure = {
  reason: UserAccessTokenFailureReason;
  claim?: "aud" | "exp" | "iss" | "nbf";
};

type JoseErrorDetails = {
  code?: unknown;
  claim?: unknown;
};

const joseErrorDetails = (error: unknown): JoseErrorDetails =>
  error !== null && typeof error === "object"
    ? (error as JoseErrorDetails)
    : {};

const knownClaim = (
  value: unknown,
): UserAccessTokenFailure["claim"] | undefined => {
  switch (value) {
    case "aud":
    case "exp":
    case "iss":
    case "nbf":
      return value;
    default:
      return undefined;
  }
};

const describeJwtVerificationFailure = (
  cause: unknown,
): UserAccessTokenFailure => {
  const details = joseErrorDetails(cause);
  const claim = knownClaim(details.claim);

  switch (details.code) {
    case "ERR_JWT_EXPIRED":
      return { reason: "jwt_expired", claim: "exp" };
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if (claim === "iss") return { reason: "jwt_issuer_mismatch", claim };
      if (claim === "aud") return { reason: "jwt_audience_mismatch", claim };
      if (claim === "nbf") return { reason: "jwt_not_active", claim };
      if (claim === "exp") return { reason: "jwt_expired", claim };
      return { reason: "jwt_claim_invalid" };
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return { reason: "jwt_signature_invalid" };
    case "ERR_JWKS_NO_MATCHING_KEY":
      return { reason: "jwt_signing_key_not_found" };
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return { reason: "jwt_signing_key_ambiguous" };
    case "ERR_JWK_INVALID":
    case "ERR_JWKS_INVALID":
      return { reason: "jwks_invalid" };
    case "ERR_JWKS_TIMEOUT":
      return { reason: "jwks_timeout" };
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return { reason: "jwt_algorithm_not_allowed" };
    case "ERR_JWS_INVALID":
    case "ERR_JWT_INVALID":
      return { reason: "jwt_malformed" };
    default:
      return cause instanceof TypeError
        ? { reason: "jwks_unavailable" }
        : { reason: "jwt_verification_failed" };
  }
};

export const describeUserAccessTokenFailure = (
  error: unknown,
): UserAccessTokenFailure => {
  if (!(error instanceof AuthorizationError)) return { reason: "unknown" };

  switch (error.message) {
    case "Jwt sub is missing":
      return { reason: "missing_subject" };
    case "Current service does not allow third-party access":
      return { reason: "third_party_access_denied" };
    case "Jwt client_id is missing":
      return { reason: "missing_client_id" };
    case "Jwt talesofai_uuid is missing":
      return { reason: "missing_user_id" };
    case "Jwt is invalid":
      return describeJwtVerificationFailure(error.cause);
    default:
      return { reason: "unknown" };
  }
};
