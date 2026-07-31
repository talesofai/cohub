import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IdentityMappingConflictError,
  UnresolvedLegacyIdentityError,
  resolveStoredPrincipalIdentity,
  type IdentityMappingRow,
} from "@cohub/identity";
import { resolveSandboxPrincipalIdentities } from "./sandbox-principal-identity.js";

const actorLegacyUuid = "5d4ac7d3-1f50-4af4-8d75-6df54d5edc6a";
const ownerLegacyUuid = "59dad1f7-807d-4ac6-8a95-747f475f84b1";
const actorSub = "actor-logto-sub";
const ownerSub = "owner-logto-sub";

const resolverWithMappings = (mappings: IdentityMappingRow[]) => async (principalId: string) => {
  const matches = mappings.filter(
    (mapping) => mapping.userUuid === principalId || mapping.logtoUserId === principalId,
  );
  return resolveStoredPrincipalIdentity({ principalId, mappings: matches });
};

describe("sandbox principal identity", () => {
  it("uses canonical sub for the Pod label and owner config mount", async () => {
    const resolved = await resolveSandboxPrincipalIdentities({
      userUuid: actorLegacyUuid,
      ownerUserUuid: ownerLegacyUuid,
    }, resolverWithMappings([
      { userUuid: actorLegacyUuid, logtoUserId: actorSub },
      { userUuid: ownerLegacyUuid, logtoUserId: ownerSub },
    ]));

    assert.equal(resolved.userId, actorSub);
    assert.equal(resolved.ownerUserId, ownerSub);
  });

  it("fails before Pod creation when a legacy owner has no mapping", async () => {
    await assert.rejects(
      resolveSandboxPrincipalIdentities({
        userUuid: actorSub,
        ownerUserUuid: ownerLegacyUuid,
      }, resolverWithMappings([])),
      UnresolvedLegacyIdentityError,
    );
  });

  it("fails before Pod creation when owner mappings conflict", async () => {
    await assert.rejects(
      resolveSandboxPrincipalIdentities({
        userUuid: actorSub,
        ownerUserUuid: ownerLegacyUuid,
      }, resolverWithMappings([
        { userUuid: ownerLegacyUuid, logtoUserId: ownerSub },
        { userUuid: ownerLegacyUuid, logtoUserId: "other-owner-sub" },
      ])),
      IdentityMappingConflictError,
    );
  });
});
