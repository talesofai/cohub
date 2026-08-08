import assert from "node:assert/strict";
import { test } from "node:test";
import { recordAuthTrace, type AuthPrincipalType } from "./auth-observability.js";

const authenticatedPrincipals: AuthPrincipalType[] = [
  "user",
  "execution",
  "preview_session",
  "work_session",
];

for (const principalType of authenticatedPrincipals) {
  test(`records safe ${principalType} auth trace attributes`, () => {
    const attributes = new Map<string, unknown>();
    recordAuthTrace(
      {
        setAttribute(key, value) {
          attributes.set(key, value);
          return this;
        },
      },
      { credentialPresent: true, principalType, outcome: "authenticated" },
    );

    assert.deepEqual(Object.fromEntries(attributes), {
      "cohub.auth.credential_present": true,
      "cohub.auth.principal_type": principalType,
      "cohub.auth.outcome": "authenticated",
    });
  });
}

test("records anonymous auth without credential details", () => {
  const attributes = new Map<string, unknown>();
  recordAuthTrace(
    {
      setAttribute(key, value) {
        attributes.set(key, value);
        return this;
      },
    },
    { credentialPresent: false, principalType: "anonymous", outcome: "anonymous" },
  );

  assert.deepEqual(Object.fromEntries(attributes), {
    "cohub.auth.credential_present": false,
    "cohub.auth.principal_type": "anonymous",
    "cohub.auth.outcome": "anonymous",
  });
});

test("records only a fixed failure category for rejected credentials", () => {
  const attributes = new Map<string, unknown>();
  recordAuthTrace(
    {
      setAttribute(key, value) {
        attributes.set(key, value);
        return this;
      },
    },
    {
      credentialPresent: true,
      principalType: "anonymous",
      outcome: "rejected",
      failureCategory: "invalid_user_token",
    },
  );

  assert.deepEqual(Object.fromEntries(attributes), {
    "cohub.auth.credential_present": true,
    "cohub.auth.principal_type": "anonymous",
    "cohub.auth.outcome": "rejected",
    "cohub.auth.failure_category": "invalid_user_token",
  });
});
