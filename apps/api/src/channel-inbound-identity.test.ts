import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IdentityMappingConflictError,
  UnresolvedLegacyIdentityError,
  resolveStoredPrincipalIdentity,
  type IdentityMappingRow,
} from "@cohub/identity";
import { resolveChannelInboundOwnerIdentity } from "./channel-inbound-identity.js";

const legacyUuid = "5d4ac7d3-1f50-4af4-8d75-6df54d5edc6a";
const sub = "logto-user";

const resolverWithMappings = (mappings: IdentityMappingRow[]) => async (principalId: string) =>
  resolveStoredPrincipalIdentity({ principalId, mappings });

describe("channel inbound owner identity", () => {
  it("uses canonical sub for new gateway writes and retains the legacy permission alias", async () => {
    const identity = await resolveChannelInboundOwnerIdentity(
      legacyUuid,
      resolverWithMappings([{ userUuid: legacyUuid, logtoUserId: sub }]),
    );

    assert.deepEqual(identity, { userId: sub, legacyUserUuid: legacyUuid });
  });

  it("fails closed when a legacy channel owner has no mapping", async () => {
    await assert.rejects(
      resolveChannelInboundOwnerIdentity(legacyUuid, resolverWithMappings([])),
      UnresolvedLegacyIdentityError,
    );
  });

  it("fails closed when channel owner mappings conflict", async () => {
    await assert.rejects(
      resolveChannelInboundOwnerIdentity(
        legacyUuid,
        resolverWithMappings([
          { userUuid: legacyUuid, logtoUserId: sub },
          { userUuid: legacyUuid, logtoUserId: "other-sub" },
        ]),
      ),
      IdentityMappingConflictError,
    );
  });
});
