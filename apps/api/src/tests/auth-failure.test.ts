import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError } from "@cohub/identity";
import { describeUserAccessTokenFailure } from "../auth-failure.js";

test("classifies JWT verification failures without exposing the original error", () => {
  const error = new AuthorizationError("Jwt is invalid", 401, {
    code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    claim: "aud",
    message: "sensitive upstream detail",
    token: "must-not-escape",
  });

  const failure = describeUserAccessTokenFailure(error);

  assert.deepEqual(failure, {
    reason: "jwt_audience_mismatch",
    claim: "aud",
  });
  assert.equal(JSON.stringify(failure).includes("sensitive"), false);
  assert.equal(JSON.stringify(failure).includes("must-not-escape"), false);
});

test("distinguishes common signature, expiry, and JWKS failures", () => {
  const classify = (code: string, claim?: string) =>
    describeUserAccessTokenFailure(
      new AuthorizationError("Jwt is invalid", 401, { code, claim }),
    );

  assert.deepEqual(classify("ERR_JWT_EXPIRED", "exp"), {
    reason: "jwt_expired",
    claim: "exp",
  });
  assert.deepEqual(classify("ERR_JWS_SIGNATURE_VERIFICATION_FAILED"), {
    reason: "jwt_signature_invalid",
  });
  assert.deepEqual(classify("ERR_JWKS_NO_MATCHING_KEY"), {
    reason: "jwt_signing_key_not_found",
  });
  assert.deepEqual(classify("ERR_JWKS_TIMEOUT"), {
    reason: "jwks_timeout",
  });
});

test("classifies Cohub-required claim failures", () => {
  assert.deepEqual(
    describeUserAccessTokenFailure(
      new AuthorizationError("Jwt sub is missing", 401),
    ),
    { reason: "missing_subject" },
  );
  assert.deepEqual(
    describeUserAccessTokenFailure(
      new AuthorizationError("Jwt client_id is missing", 401),
    ),
    { reason: "missing_client_id" },
  );
  assert.deepEqual(
    describeUserAccessTokenFailure(
      new AuthorizationError("Jwt talesofai_uuid is missing", 401),
    ),
    { reason: "missing_user_id" },
  );
});
