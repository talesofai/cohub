import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IdentityMappingConflictError,
  UnresolvedLegacyIdentityError,
} from "@cohub/identity";
import { resolveCanonicalStoredUserIds } from "./session-fork-identity.js";

const legacyUuid = "5d4ac7d3-1f50-4af4-8d75-6df54d5edc6a";
const sub = "logto-user";

describe("session fork identity canonicalization", () => {
  it("canonicalizes participants and label provenance to sub", () => {
    const resolved = resolveCanonicalStoredUserIds(
      [legacyUuid, sub, "system"],
      [{ userUuid: legacyUuid, logtoUserId: sub }],
    );

    assert.equal(resolved.get(legacyUuid), sub);
    assert.equal(resolved.get(sub), sub);
    assert.equal(resolved.get("system"), "system");
  });

  it("fails closed for an unmapped UUID", () => {
    assert.throws(
      () => resolveCanonicalStoredUserIds([legacyUuid], []),
      UnresolvedLegacyIdentityError,
    );
  });

  it("fails closed for conflicting mappings", () => {
    assert.throws(
      () => resolveCanonicalStoredUserIds(
        [legacyUuid],
        [
          { userUuid: legacyUuid, logtoUserId: sub },
          { userUuid: legacyUuid, logtoUserId: "other-sub" },
        ],
      ),
      IdentityMappingConflictError,
    );
  });
});
