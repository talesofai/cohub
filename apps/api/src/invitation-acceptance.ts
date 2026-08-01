import { createHash } from "node:crypto";
import { isRoleHigherThan } from "@cohub/core/permissions";
import type { SpaceRole } from "@cohub/db";

const RESERVE_INVITATION_USE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 0 then
  return "missing"
end

local status = redis.call("hget", KEYS[1], "status")
if status == "revoked" then
  return "revoked"
end

local existing_reservation = redis.call("hget", KEYS[1], ARGV[1])
if existing_reservation then
  if string.sub(existing_reservation, 1, 8) == "pending:" then
    return "existing"
  end
  if existing_reservation == "committed" or existing_reservation == "1" then
    return "committed"
  end
  return "committed"
end

if status == "exhausted" then
  return "exhausted"
end

local max_uses = tonumber(redis.call("hget", KEYS[1], "max_uses") or "0") or 0
local use_count = tonumber(redis.call("hget", KEYS[1], "use_count") or "0") or 0
if max_uses > 0 and use_count >= max_uses then
  redis.call("hset", KEYS[1], "status", "exhausted")
  return "exhausted"
end

local now = redis.call("TIME")
local expires_at = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000) + tonumber(ARGV[2])
local reservation = "pending:" .. tostring(expires_at) .. ":" .. ARGV[3] .. ":" .. ARGV[4]
local new_count = use_count + 1
if max_uses > 0 and new_count >= max_uses then
  redis.call("hset", KEYS[1], ARGV[1], reservation, "use_count", tostring(new_count), "status", "exhausted")
else
  redis.call("hset", KEYS[1], ARGV[1], reservation, "use_count", tostring(new_count))
end
return "reserved"
`;

const FINALIZE_INVITATION_USE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 0 then
  return "missing"
end
local reservation = redis.call("hget", KEYS[1], ARGV[1])
if not reservation then
  return "absent"
end
if reservation == "committed" or reservation == "1" then
  return "existing"
end
if string.sub(reservation, 1, 8) ~= "pending:" then
  return "invalid"
end
redis.call("hset", KEYS[1], ARGV[1], "committed")
return "finalized"
`;

const RELEASE_INVITATION_USE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 0 then
  return "missing"
end
local reservation = redis.call("hget", KEYS[1], ARGV[1])
if not reservation then
  return "absent"
end
if string.sub(reservation, 1, 8) ~= "pending:" then
  return "committed"
end
redis.call("hdel", KEYS[1], ARGV[1])
local use_count = math.max(0, (tonumber(redis.call("hget", KEYS[1], "use_count") or "0") or 0) - 1)
local max_uses = tonumber(redis.call("hget", KEYS[1], "max_uses") or "0") or 0
local status = redis.call("hget", KEYS[1], "status")
redis.call("hset", KEYS[1], "use_count", tostring(use_count))
if status == "exhausted" and (max_uses == 0 or use_count < max_uses) then
  redis.call("hset", KEYS[1], "status", "active")
end
return "released"
`;

const INVITATION_USE_LEASE_MS = 60_000;

export type InvitationUseReservationState =
  | "reserved"
  | "existing"
  | "committed"
  | "missing"
  | "revoked"
  | "exhausted";

export type InvitationUseFinalizationState =
  | "finalized"
  | "existing"
  | "absent"
  | "missing";

export type InvitationUseReservationClient = {
  eval: (
    script: string,
    numKeys: number,
    invitationKey: string,
    ...args: string[]
  ) => Promise<unknown>;
};

type PendingInvitationUse = {
  userUuid: string;
  role: SpaceRole;
  expiresAt: number;
};

export function invitationUseReservationField(userUuid: string): string {
  const userHash = createHash("sha256").update(userUuid).digest("hex");
  return `use_reservation:${userHash}`;
}

export function hasInvitationUseReservation(
  invitation: Record<string, string>,
  userUuid: string,
): boolean {
  return invitation[invitationUseReservationField(userUuid)] !== undefined;
}

export function invitationUseAvailability(
  invitation: Record<string, string>,
  userUuid?: string,
): "active" | "pending" | "revoked" | "exhausted" {
  if (invitation.status === "revoked") return "revoked";
  if (userUuid && hasInvitationUseReservation(invitation, userUuid)) return "active";

  const maxUses = Number.parseInt(invitation.max_uses ?? "0", 10);
  const useCount = Number.parseInt(invitation.use_count ?? "0", 10);
  if (invitation.status === "exhausted" || (maxUses > 0 && useCount >= maxUses)) {
    if (Object.entries(invitation).some(([field, value]) => (
      field.startsWith("use_reservation:") && value.startsWith("pending:")
    ))) return "pending";
    return "exhausted";
  }
  return "active";
}

export async function reserveInvitationUse(
  invitationKey: string,
  userUuid: string,
  invitedRole: SpaceRole,
  client: InvitationUseReservationClient,
  leaseMs = INVITATION_USE_LEASE_MS,
): Promise<InvitationUseReservationState> {
  const result = await client.eval(
    RESERVE_INVITATION_USE_SCRIPT,
    1,
    invitationKey,
    invitationUseReservationField(userUuid),
    String(leaseMs),
    userUuid,
    invitedRole,
  );
  if (
    result === "reserved"
    || result === "existing"
    || result === "committed"
    || result === "missing"
    || result === "revoked"
    || result === "exhausted"
  ) {
    return result;
  }
  throw new Error("invalid invitation reservation response");
}

export async function finalizeInvitationUse(
  invitationKey: string,
  userUuid: string,
  client: InvitationUseReservationClient,
): Promise<InvitationUseFinalizationState> {
  const result = await client.eval(
    FINALIZE_INVITATION_USE_SCRIPT,
    1,
    invitationKey,
    invitationUseReservationField(userUuid),
  );
  if (result === "finalized" || result === "existing" || result === "absent" || result === "missing") {
    return result;
  }
  throw new Error("invalid invitation finalization response");
}

export async function releaseInvitationUse(
  invitationKey: string,
  userUuid: string,
  client: InvitationUseReservationClient,
): Promise<void> {
  const result = await client.eval(
    RELEASE_INVITATION_USE_SCRIPT,
    1,
    invitationKey,
    invitationUseReservationField(userUuid),
  );
  if (result === "released" || result === "committed" || result === "absent" || result === "missing") return;
  throw new Error("invalid invitation release response");
}

export function expiredInvitationUses(
  invitation: Record<string, string>,
  now = Date.now(),
): PendingInvitationUse[] {
  const roles = new Set<SpaceRole>(["host", "builder", "guest"]);
  const pending: PendingInvitationUse[] = [];
  for (const [field, value] of Object.entries(invitation)) {
    if (!field.startsWith("use_reservation:") || !value.startsWith("pending:")) continue;
    const [kind, rawExpiresAt, userUuid, rawRole, ...extra] = value.split(":");
    const expiresAt = Number(rawExpiresAt);
    if (
      kind !== "pending"
      || extra.length > 0
      || !Number.isSafeInteger(expiresAt)
      || expiresAt > now
      || !userUuid
      || !roles.has(rawRole as SpaceRole)
    ) continue;
    pending.push({ userUuid, role: rawRole as SpaceRole, expiresAt });
  }
  return pending;
}

export async function reconcileExpiredInvitationUses(
  invitationKey: string,
  invitation: Record<string, string>,
  getRole: (userUuid: string) => Promise<SpaceRole | null>,
  client: InvitationUseReservationClient,
  now = Date.now(),
): Promise<void> {
  for (const pending of expiredInvitationUses(invitation, now)) {
    const currentRole = await getRole(pending.userUuid);
    if (currentRole && !isRoleHigherThan(pending.role, currentRole)) {
      await finalizeInvitationUse(invitationKey, pending.userUuid, client);
    } else {
      await releaseInvitationUse(invitationKey, pending.userUuid, client);
    }
  }
}

type InvitationMembershipDependencies = {
  getRole: () => Promise<SpaceRole | null>;
  hasReservedUse: () => Promise<boolean>;
  reserveUse: () => Promise<InvitationUseReservationState>;
  applyRole: () => Promise<SpaceRole>;
  releaseUse: () => Promise<void>;
};

export type InvitationMembershipAcceptance =
  | { state: "accepted"; role: SpaceRole; pendingFinalization: boolean }
  | { state: "missing" | "revoked" | "exhausted" | "used" };

export async function acceptInvitationMembership(
  invitedRole: SpaceRole,
  dependencies: InvitationMembershipDependencies,
): Promise<InvitationMembershipAcceptance> {
  const existingRole = await dependencies.getRole();
  if (existingRole && !isRoleHigherThan(invitedRole, existingRole)) {
    return {
      state: "accepted",
      role: existingRole,
      pendingFinalization: await dependencies.hasReservedUse(),
    };
  }

  const reservation = await dependencies.reserveUse();
  if (reservation === "missing" || reservation === "revoked" || reservation === "exhausted") {
    return { state: reservation };
  }
  if (reservation === "committed") return { state: "used" };

  let role: SpaceRole;
  try {
    role = await dependencies.applyRole();
  } catch (error) {
    await dependencies.releaseUse().catch(() => undefined);
    throw error;
  }
  return { state: "accepted", role, pendingFinalization: true };
}
