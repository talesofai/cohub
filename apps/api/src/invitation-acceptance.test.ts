import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpaceRole } from "@cohub/db";
import {
  acceptInvitationMembership,
  finalizeInvitationUse,
  hasInvitationUseReservation,
  invitationUseAvailability,
  reconcileExpiredInvitationUses,
  releaseInvitationUse,
  reserveInvitationUse,
} from "./invitation-acceptance.js";
import { invitationMembershipLockId, withInvitationLock } from "./invitation-lock.js";

type InvitationState = {
  maxUses: number;
  useCount: number;
  status: "active" | "exhausted" | "revoked";
  reservations: Map<string, string>;
};

const roleRank: Record<SpaceRole, number> = { guest: 0, builder: 1, host: 2 };

class FakeInvitationRedis {
  readonly invitations = new Map<string, InvitationState>();
  private readonly locks = new Map<string, string>();
  now = 1_000;

  async set(
    key: string,
    value: string,
    _mode: "PX",
    _ttlMs: number,
    _condition: "NX",
  ): Promise<"OK" | null> {
    if (this.locks.has(key)) return null;
    this.locks.set(key, value);
    return "OK";
  }

  async eval(
    script: string,
    _numKeys: number,
    key: string,
    ...args: string[]
  ): Promise<unknown> {
    if (key.startsWith("invite:token-lock:")) {
      if (this.locks.get(key) !== args[0]) return 0;
      if (script.includes("pexpire")) return 1;
      this.locks.delete(key);
      return 1;
    }

    const invitation = this.invitations.get(key);
    if (!invitation) return "missing";
    const field = args[0];
    assert.ok(field);

    if (script.includes('return "finalized"')) {
      const reservation = invitation.reservations.get(field);
      if (!reservation) return "absent";
      if (reservation === "committed" || reservation === "1") return "existing";
      invitation.reservations.set(field, "committed");
      return "finalized";
    }

    if (script.includes('return "released"')) {
      const reservation = invitation.reservations.get(field);
      if (!reservation) return "absent";
      if (!reservation.startsWith("pending:")) return "committed";
      invitation.reservations.delete(field);
      invitation.useCount = Math.max(0, invitation.useCount - 1);
      if (
        invitation.status === "exhausted"
        && (invitation.maxUses === 0 || invitation.useCount < invitation.maxUses)
      ) invitation.status = "active";
      return "released";
    }

    if (invitation.status === "revoked") return "revoked";
    const existingReservation = invitation.reservations.get(field);
    if (existingReservation?.startsWith("pending:")) return "existing";
    if (existingReservation === "committed" || existingReservation === "1") return "committed";
    if (
      invitation.status === "exhausted"
      || (invitation.maxUses > 0 && invitation.useCount >= invitation.maxUses)
    ) {
      invitation.status = "exhausted";
      return "exhausted";
    }

    const leaseMs = Number(args[1]);
    const userUuid = args[2];
    const role = args[3];
    invitation.reservations.set(field, `pending:${this.now + leaseMs}:${userUuid}:${role}`);
    invitation.useCount += 1;
    if (invitation.maxUses > 0 && invitation.useCount >= invitation.maxUses) {
      invitation.status = "exhausted";
    }
    return "reserved";
  }

  record(key: string): Record<string, string> {
    const invitation = this.invitations.get(key);
    assert.ok(invitation);
    return Object.fromEntries([
      ["max_uses", String(invitation.maxUses)],
      ["use_count", String(invitation.useCount)],
      ["status", invitation.status],
      ...invitation.reservations,
    ]);
  }
}

function membershipDependencies(input: {
  invitationKey: string;
  redis: FakeInvitationRedis;
  roleByUser: Map<string, SpaceRole>;
  userUuid: string;
  role?: SpaceRole;
  failApply?: () => boolean;
}) {
  const invitedRole = input.role ?? "builder";
  return {
    getRole: async () => input.roleByUser.get(input.userUuid) ?? null,
    hasReservedUse: async () => hasInvitationUseReservation(input.redis.record(input.invitationKey), input.userUuid),
    reserveUse: () => reserveInvitationUse(
      input.invitationKey,
      input.userUuid,
      invitedRole,
      input.redis,
      1_000,
    ),
    applyRole: async () => {
      if (input.failApply?.()) throw new Error("database unavailable");
      const current = input.roleByUser.get(input.userUuid);
      const role = current && roleRank[current] >= roleRank[invitedRole] ? current : invitedRole;
      input.roleByUser.set(input.userUuid, role);
      return role;
    },
    finalizeUse: () => finalizeInvitationUse(input.invitationKey, input.userUuid, input.redis),
    releaseUse: () => releaseInvitationUse(input.invitationKey, input.userUuid, input.redis),
  };
}

async function acceptAndFinalize(
  invitedRole: SpaceRole,
  dependencies: ReturnType<typeof membershipDependencies>,
) {
  const result = await acceptInvitationMembership(invitedRole, dependencies);
  if (result.state === "accepted" && result.pendingFinalization) {
    const finalization = await dependencies.finalizeUse();
    assert.ok(finalization === "finalized" || finalization === "existing");
  }
  return result;
}

describe("invitation use reservations", () => {
  it("serializes concurrent accepts and never exceeds maxUses", async () => {
    const token = "single-use-token";
    const invitationKey = `invite:${token}`;
    const redis = new FakeInvitationRedis();
    redis.invitations.set(invitationKey, {
      maxUses: 1,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    });
    const roleByUser = new Map<string, SpaceRole>();
    const accept = (userUuid: string) => withInvitationLock(
      token,
      () => acceptAndFinalize("builder", membershipDependencies({
        invitationKey,
        redis,
        roleByUser,
        userUuid,
      })),
      redis,
    );

    const results = await Promise.all([accept("user-1"), accept("user-2")]);
    assert.equal(results.filter((result) => result.state === "accepted").length, 1);
    assert.equal(results.filter((result) => result.state === "exhausted").length, 1);
    assert.equal(roleByUser.size, 1);
    assert.equal(redis.invitations.get(invitationKey)?.useCount, 1);
  });

  it("releases a failed database write so another user can accept", async () => {
    const invitationKey = "invite:database-failure";
    const redis = new FakeInvitationRedis();
    redis.invitations.set(invitationKey, {
      maxUses: 1,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    });
    const roleByUser = new Map<string, SpaceRole>();

    await assert.rejects(
      acceptInvitationMembership("builder", membershipDependencies({
        invitationKey,
        redis,
        roleByUser,
        userUuid: "failed-user",
        failApply: () => true,
      })),
      /database unavailable/,
    );
    assert.equal(redis.invitations.get(invitationKey)?.useCount, 0);
    assert.equal(invitationUseAvailability(redis.record(invitationKey), "next-user"), "active");
    assert.deepEqual(
      await acceptAndFinalize("builder", membershipDependencies({
        invitationKey,
        redis,
        roleByUser,
        userUuid: "next-user",
      })),
      { state: "accepted", role: "builder", pendingFinalization: true },
    );
  });

  it("reclaims an expired reservation when the membership write never happened", async () => {
    const invitationKey = "invite:crashed-before-database";
    const redis = new FakeInvitationRedis();
    redis.invitations.set(invitationKey, {
      maxUses: 1,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    });
    assert.equal(await reserveInvitationUse(invitationKey, "crashed-user", "builder", redis, 1_000), "reserved");
    assert.equal(invitationUseAvailability(redis.record(invitationKey)), "pending");
    redis.now += 1_001;

    await reconcileExpiredInvitationUses(
      invitationKey,
      redis.record(invitationKey),
      async () => null,
      redis,
      redis.now,
    );
    assert.equal(redis.invitations.get(invitationKey)?.useCount, 0);
    assert.equal(await reserveInvitationUse(invitationKey, "next-user", "builder", redis), "reserved");
  });

  it("finalizes an expired reservation when the membership write committed before a crash", async () => {
    const invitationKey = "invite:crashed-after-database";
    const redis = new FakeInvitationRedis();
    redis.invitations.set(invitationKey, {
      maxUses: 1,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    });
    assert.equal(await reserveInvitationUse(invitationKey, "committed-user", "builder", redis, 1_000), "reserved");
    redis.now += 1_001;

    await reconcileExpiredInvitationUses(
      invitationKey,
      redis.record(invitationKey),
      async (userUuid) => userUuid === "committed-user" ? "builder" : null,
      redis,
      redis.now,
    );
    assert.equal(redis.invitations.get(invitationKey)?.useCount, 1);
    assert.equal(await reserveInvitationUse(invitationKey, "next-user", "builder", redis), "exhausted");
  });

  it("serializes different invitation tokens and keeps the highest role", async () => {
    const spaceId = "space-1";
    const userUuid = "user-1";
    const redis = new FakeInvitationRedis();
    const roleByUser = new Map<string, SpaceRole>();
    for (const token of ["host-token", "builder-token"]) {
      redis.invitations.set(`invite:${token}`, {
        maxUses: 1,
        useCount: 0,
        status: "active",
        reservations: new Map(),
      });
    }
    const accept = (token: string, role: SpaceRole) => withInvitationLock(
      token,
      () => withInvitationLock(
        invitationMembershipLockId(spaceId, userUuid),
        () => acceptAndFinalize(role, membershipDependencies({
          invitationKey: `invite:${token}`,
          redis,
          roleByUser,
          userUuid,
          role,
        })),
        redis,
      ),
      redis,
    );

    await Promise.all([accept("host-token", "host"), accept("builder-token", "builder")]);
    assert.equal(roleByUser.get(userUuid), "host");
  });

  it("does not write membership when Redis reservation fails", async () => {
    let applied = false;
    await assert.rejects(
      acceptInvitationMembership("builder", {
        getRole: async () => null,
        hasReservedUse: async () => false,
        reserveUse: () => reserveInvitationUse("invite:offline", "user-1", "builder", {
          eval: async () => { throw new Error("redis unavailable"); },
        }),
        applyRole: async () => {
          applied = true;
          return "builder";
        },
        releaseUse: async () => undefined,
      }),
      /redis unavailable/,
    );
    assert.equal(applied, false);
  });

  it("leaves the reservation pending until the membership transaction commits", async () => {
    const result = await acceptInvitationMembership("builder", {
      getRole: async () => null,
      hasReservedUse: async () => false,
      reserveUse: async () => "reserved",
      applyRole: async () => "builder",
      releaseUse: async () => undefined,
    });
    assert.deepEqual(result, { state: "accepted", role: "builder", pendingFinalization: true });
  });

  it("does not let an existing reservation bypass a later revoke", async () => {
    const invitationKey = "invite:revoked";
    const userUuid = "reserved-user";
    const redis = new FakeInvitationRedis();
    const invitation: InvitationState = {
      maxUses: 1,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    };
    redis.invitations.set(invitationKey, invitation);

    assert.equal(await reserveInvitationUse(invitationKey, userUuid, "builder", redis), "reserved");
    invitation.status = "revoked";
    assert.equal(invitationUseAvailability(redis.record(invitationKey), userUuid), "revoked");
    assert.equal(await reserveInvitationUse(invitationKey, userUuid, "builder", redis), "revoked");
  });

  it("does not restore a removed or downgraded membership from a consumed invitation", async () => {
    const invitationKey = "invite:consumed";
    const redis = new FakeInvitationRedis();
    redis.invitations.set(invitationKey, {
      maxUses: 0,
      useCount: 0,
      status: "active",
      reservations: new Map(),
    });
    const roleByUser = new Map<string, SpaceRole>();
    const accept = (userUuid: string, role: SpaceRole) => acceptAndFinalize(
      role,
      membershipDependencies({ invitationKey, redis, roleByUser, userUuid, role }),
    );

    assert.deepEqual(await accept("removed-user", "builder"), { state: "accepted", role: "builder", pendingFinalization: true });
    roleByUser.delete("removed-user");
    assert.deepEqual(await accept("removed-user", "builder"), { state: "used" });
    assert.equal(roleByUser.has("removed-user"), false);

    assert.deepEqual(await accept("downgraded-user", "host"), { state: "accepted", role: "host", pendingFinalization: true });
    roleByUser.set("downgraded-user", "guest");
    assert.deepEqual(await accept("downgraded-user", "host"), { state: "used" });
    assert.equal(roleByUser.get("downgraded-user"), "guest");
  });
});
