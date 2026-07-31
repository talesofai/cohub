import { randomBytes } from "node:crypto";
import {
  referralCodes,
  referrals,
  sessionTurns,
  userProfiles,
  type ReferralStatus,
} from "@cohub/db";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { getIdentityKeys, identityEquals, resolveStoredPrincipalUser } from "./identity-bridge.js";
import type { PrincipalIdentity } from "@cohub/identity";

export const REFERRAL_REWARD_USD = 5;

const successfulTurnStatuses = ["completed"] as const;

function generateReferralCode() {
  return randomBytes(9).toString("base64url");
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function ensureReferralCode(user: PrincipalIdentity) {
  const identityKeys = getIdentityKeys(user);
  const existingCodes = await db
    .select()
    .from(referralCodes)
    .where(and(inArray(referralCodes.userId, identityKeys), eq(referralCodes.status, "active")));
  if (existingCodes.length > 1) throw new Error("referral identity conflict requires repair");
  const existing = existingCodes[0];
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [created] = await db
      .insert(referralCodes)
      .values({ userId: user.uuid, code: generateReferralCode() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [concurrent] = await db
      .select()
      .from(referralCodes)
      .where(and(inArray(referralCodes.userId, identityKeys), eq(referralCodes.status, "active")))
      .limit(1);
    if (concurrent) return concurrent;
  }
  throw new Error("failed to create referral code");
}

export async function rotateReferralCode(user: PrincipalIdentity) {
  const now = new Date();
  const identityKeys = getIdentityKeys(user);
  return db.transaction(async (tx) => {
    await tx
      .update(referralCodes)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(inArray(referralCodes.userId, identityKeys), eq(referralCodes.status, "active")));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [created] = await tx
        .insert(referralCodes)
        .values({ userId: user.uuid, code: generateReferralCode() })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
    }
    throw new Error("failed to rotate referral code");
  });
}

export async function getPublicReferral(code: string) {
  const [result] = await db
    .select({
      codeId: referralCodes.id,
      inviterUserId: referralCodes.userId,
      profile: {
        userUuid: userProfiles.logtoUserId,
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
    })
    .from(referralCodes)
    .leftJoin(userProfiles, or(
      eq(userProfiles.userUuid, referralCodes.userId),
      eq(userProfiles.logtoUserId, referralCodes.userId),
    ))
    .where(and(eq(referralCodes.code, code), eq(referralCodes.status, "active")))
    .limit(1);
  return result ?? null;
}

export type ClaimReferralResult = {
  referralId: string | null;
  status: ReferralStatus | "self" | "existing_user" | "already_claimed";
};

export async function claimReferral(code: string, invitee: PrincipalIdentity): Promise<ClaimReferralResult | null> {
  const publicReferral = await getPublicReferral(code);
  if (!publicReferral) return null;
  if (identityEquals(invitee, publicReferral.inviterUserId)) {
    return { referralId: null, status: "self" };
  }
  const inviteeIdentityKeys = getIdentityKeys(invitee);

  const existingRows = await db
    .select({
      id: referrals.id,
      referralCodeId: referrals.referralCodeId,
      status: referrals.status,
    })
    .from(referrals)
    .where(inArray(referrals.inviteeUserId, inviteeIdentityKeys));
  if (existingRows.length > 1) throw new Error("referral identity conflict requires repair");
  const existing = existingRows[0];
  if (existing) {
    return {
      referralId: existing.id,
      status:
        existing.referralCodeId === publicReferral.codeId
          ? existing.status
          : "already_claimed",
    };
  }

  const [successfulTurn] = await db
    .select({ id: sessionTurns.id })
    .from(sessionTurns)
    .where(
      and(
        inArray(sessionTurns.userUuid, inviteeIdentityKeys),
        inArray(sessionTurns.status, [...successfulTurnStatuses]),
      ),
    )
    .limit(1);
  if (successfulTurn) return { referralId: null, status: "existing_user" };
  const inviterIdentity = await resolveStoredPrincipalUser(publicReferral.inviterUserId);

  const [created] = await db
    .insert(referrals)
    .values({
      referralCodeId: publicReferral.codeId,
      inviterUserId: inviterIdentity.uuid,
      inviteeUserId: invitee.uuid,
      inviterRewardAmountUsd: String(REFERRAL_REWARD_USD),
      inviteeRewardAmountUsd: String(REFERRAL_REWARD_USD),
    })
    .onConflictDoNothing({ target: referrals.inviteeUserId })
    .returning({ id: referrals.id, status: referrals.status });

  if (created) return { referralId: created.id, status: created.status };
  const [concurrent] = await db
    .select({
      id: referrals.id,
      referralCodeId: referrals.referralCodeId,
      status: referrals.status,
    })
    .from(referrals)
    .where(inArray(referrals.inviteeUserId, inviteeIdentityKeys))
    .limit(1);
  if (!concurrent) return null;
  return {
    referralId: concurrent.id,
    status:
      concurrent.referralCodeId === publicReferral.codeId
        ? concurrent.status
        : "already_claimed",
  };
}

export async function getReferralDashboard(user: PrincipalIdentity) {
  const code = await ensureReferralCode(user);
  const items = await db
    .select({
      id: referrals.id,
      status: referrals.status,
      claimedAt: referrals.claimedAt,
      qualifiedAt: referrals.qualifiedAt,
      rewardedAt: referrals.rewardedAt,
      inviterRewardAmountUsd: referrals.inviterRewardAmountUsd,
      profile: {
        userUuid: userProfiles.logtoUserId,
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
    })
    .from(referrals)
    .leftJoin(userProfiles, or(
      eq(userProfiles.userUuid, referrals.inviteeUserId),
      eq(userProfiles.logtoUserId, referrals.inviteeUserId),
    ))
    .where(inArray(referrals.inviterUserId, getIdentityKeys(user)))
    .orderBy(desc(referrals.claimedAt));

  const pending = items.filter((item) => item.status === "pending").length;
  const qualified = items.filter((item) => item.status === "qualified").length;
  const rewardedItems = items.filter((item) => item.status === "rewarded");
  const rewarded = rewardedItems.length;
  const earnedUsd = Number(
    rewardedItems
      .reduce((total, item) => total + Number(item.inviterRewardAmountUsd), 0)
      .toFixed(8),
  );
  return {
    code: code.code,
    reward: { inviterUsd: REFERRAL_REWARD_USD, inviteeUsd: REFERRAL_REWARD_USD },
    summary: {
      total: items.length,
      pending,
      qualified,
      rewarded,
      earnedUsd,
    },
    items: items.map(({ inviterRewardAmountUsd: _, ...item }) => ({
      ...item,
      claimedAt: toIso(item.claimedAt),
      qualifiedAt: toIso(item.qualifiedAt),
      rewardedAt: toIso(item.rewardedAt),
      profile: item.profile?.userUuid ? item.profile : null,
    })),
  };
}
