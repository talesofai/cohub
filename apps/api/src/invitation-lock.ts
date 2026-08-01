import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@cohub/infra/logging";
import { sql } from "drizzle-orm";
import { db } from "./db/index.js";

const logger = createLogger({ serviceName: "cohub-api" });
const INVITE_LOCK_TTL_MS = 30_000;
const INVITE_LOCK_WAIT_MS = 5_000;
const INVITE_LOCK_RETRY_MS = 25;
const REFRESH_INVITE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE_INVITE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export type InvitationLockClient = {
  set: (key: string, value: string, mode: "PX", ttlMs: number, condition: "NX") => Promise<"OK" | null>;
  eval: (script: string, numKeys: number, lockKey: string, ...args: string[]) => Promise<unknown>;
};

export class InvitationLockTimeoutError extends Error {
  override name = "InvitationLockTimeoutError";
}

export function invitationLockKey(token: string): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return `invite:token-lock:${tokenHash}`;
}

export function invitationMembershipLockId(spaceId: string, userUuid: string): string {
  return `membership:${spaceId}:${userUuid}`;
}

type InvitationTransactionCallback = Parameters<typeof db.transaction>[0];
export type InvitationTransaction = Parameters<InvitationTransactionCallback>[0];

function invitationAdvisoryLockKeys(token: string): [number, number] {
  const digest = createHash("sha256").update(token).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function withInvitationDatabaseLock<T>(
  token: string,
  fn: (transaction: InvitationTransaction) => Promise<T>,
): Promise<T> {
  const [firstKey, secondKey] = invitationAdvisoryLockKeys(token);
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${firstKey}, ${secondKey})`,
    );
    return fn(transaction);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withInvitationLock<T>(
  token: string,
  fn: () => Promise<T>,
  client: InvitationLockClient,
  options: { ttlMs?: number } = {},
): Promise<T> {
  const lockKey = invitationLockKey(token);
  const lockToken = randomUUID();
  const deadline = Date.now() + INVITE_LOCK_WAIT_MS;
  const ttlMs = options.ttlMs ?? INVITE_LOCK_TTL_MS;

  while (true) {
    const acquired = await client.set(lockKey, lockToken, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() >= deadline) throw new InvitationLockTimeoutError("invitation is busy");
    await sleep(INVITE_LOCK_RETRY_MS);
  }

  let lockLost = false;
  let refreshTail = Promise.resolve();
  const refresh = () => {
    refreshTail = refreshTail.then(async () => {
      const refreshed = await client.eval(
        REFRESH_INVITE_LOCK_SCRIPT,
        1,
        lockKey,
        lockToken,
        String(ttlMs),
      );
      if (refreshed !== 1) lockLost = true;
    }).catch((error) => {
      lockLost = true;
      logger.warn("[Invite] failed to refresh token lock", { lockKey, error });
    });
  };
  const refreshTimer = setInterval(refresh, Math.max(1, Math.floor(ttlMs / 3)));
  refreshTimer.unref?.();
  try {
    const result = await fn();
    await refreshTail;
    if (lockLost) throw new InvitationLockTimeoutError("invitation lock was lost");
    return result;
  } finally {
    clearInterval(refreshTimer);
    await refreshTail;
    await client.eval(RELEASE_INVITE_LOCK_SCRIPT, 1, lockKey, lockToken).catch((error) => {
      logger.warn("[Invite] failed to release token lock", { lockKey, error });
    });
  }
}
