import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BillingIdentityUnavailableError,
  IdentityMappingConflictError,
  UnresolvedLegacyIdentityError,
  getIdentityKeys,
  isStorageSafePrincipalId,
  resolveLegacyBillingIdentity,
  resolveStoredPrincipalIdentity,
  resolveStoredPrincipalIdentityForRead,
  resolveVerifiedPrincipalIdentity,
  resolveVerifiedPrincipalIdentityWithPersistence,
} from "./index.js";

const legacyUuid = "5d4ac7d3-1f50-4af4-8d75-6df54d5edc6a";
const sub = "abc123logtosub";
const mapping = [{ userUuid: legacyUuid, logtoUserId: sub }];

describe("principal identity migration", () => {
  it("uses verified sub as canonical and keeps the stored UUID as an alias", () => {
    const identity = resolveVerifiedPrincipalIdentity({ sub, mappings: mapping });
    assert.deepEqual(identity, { uuid: sub, legacyUserUuid: legacyUuid });
    assert.deepEqual(getIdentityKeys(identity), [sub, legacyUuid]);
  });

  it("persists a missing verified mapping before async consumers receive only sub", async () => {
    const rows: Array<{ userUuid: string; logtoUserId: string }> = [];
    const identity = await resolveVerifiedPrincipalIdentityWithPersistence({
      sub,
      legacyUserUuid: legacyUuid,
      loadMappings: async () => rows,
      persistMapping: async (resolved) => {
        rows.push({ userUuid: resolved.legacyUserUuid ?? resolved.uuid, logtoUserId: resolved.uuid });
      },
    });
    assert.deepEqual(identity, { uuid: sub, legacyUserUuid: legacyUuid });
    assert.deepEqual(rows, mapping);
  });

  it("fails closed when a verified mapping cannot be persisted", async () => {
    await assert.rejects(
      resolveVerifiedPrincipalIdentityWithPersistence({
        sub,
        legacyUserUuid: legacyUuid,
        loadMappings: async () => [],
        persistMapping: async () => undefined,
      }),
      IdentityMappingConflictError,
    );
  });

  it("upgrades a sub-only profile row when the verified legacy UUID becomes available", async () => {
    const rows = [{ userUuid: sub, logtoUserId: sub }];
    const identity = await resolveVerifiedPrincipalIdentityWithPersistence({
      sub,
      legacyUserUuid: legacyUuid,
      loadMappings: async () => rows,
      persistMapping: async (resolved) => {
        rows[0] = { userUuid: resolved.legacyUserUuid ?? resolved.uuid, logtoUserId: resolved.uuid };
      },
    });
    assert.deepEqual(identity, { uuid: sub, legacyUserUuid: legacyUuid });
    assert.deepEqual(rows, mapping);
  });

  it("resolves an old signed UUID to canonical sub", () => {
    assert.deepEqual(resolveStoredPrincipalIdentity({ principalId: legacyUuid, mappings: mapping }), {
      uuid: sub,
      legacyUserUuid: legacyUuid,
    });
  });

  it("rejects unresolved UUID principals and conflicting mappings", () => {
    assert.throws(
      () => resolveStoredPrincipalIdentity({ principalId: legacyUuid, mappings: [] }),
      UnresolvedLegacyIdentityError,
    );
    assert.throws(
      () => resolveVerifiedPrincipalIdentity({
        sub,
        mappings: [...mapping, { userUuid: "59dad1f7-807d-4ac6-8a95-747f475f84b1", logtoUserId: sub }],
      }),
      IdentityMappingConflictError,
    );
  });

  it("falls back only for an unresolved legacy read and never hides conflicts", () => {
    assert.deepEqual(
      resolveStoredPrincipalIdentityForRead({ principalId: legacyUuid, mappings: [] }),
      { uuid: legacyUuid },
    );
    assert.throws(
      () => resolveStoredPrincipalIdentityForRead({
        principalId: legacyUuid,
        mappings: [
          ...mapping,
          { userUuid: legacyUuid, logtoUserId: "different-sub" },
        ],
      }),
      IdentityMappingConflictError,
    );
  });

  it("never uses sub as the legacy Billing external user id", () => {
    assert.equal(
      resolveLegacyBillingIdentity({ identity: { uuid: sub, legacyUserUuid: legacyUuid }, mappings: mapping }),
      legacyUuid,
    );
    assert.throws(
      () => resolveLegacyBillingIdentity({ identity: { uuid: sub }, mappings: [] }),
      BillingIdentityUnavailableError,
    );
  });

  it("accepts Logto subjects for storage without allowing path traversal", () => {
    assert.equal(isStorageSafePrincipalId(sub), true);
    assert.equal(isStorageSafePrincipalId(legacyUuid), true);
    assert.equal(isStorageSafePrincipalId("../escape"), false);
    assert.equal(isStorageSafePrincipalId("user/child"), false);
  });
});
