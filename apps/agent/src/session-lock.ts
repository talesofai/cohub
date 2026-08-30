import { createHash, randomUUID } from "node:crypto";
import type { LockDbLease } from "@cohub/infra/lock-db-pool";
import { redis } from "./redis.js";
import { env } from "./env.js";
import { lockDbPool } from "./db.js";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-agent" });
const lockKey = (sessionId: string) => `agent:session:${sessionId}:lock`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const advisoryKeys = (sessionId: string): [number, number] => {
  const digest = createHash("sha256").update(`cohub-session-writer-v1\0${sessionId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
};

export type SessionLock = {
  sessionId: string;
  token: string;
  epoch: number;
  stop: () => void;
  assertHealthy: () => void;
  release: () => Promise<void>;
};

export async function acquireSessionLock(
  sessionId: string,
  options: {
    holderKind?: "cloud_agent" | "native_ingest" | "fork";
    holderId?: string;
    onLost?: (error: Error) => void;
  } = {},
): Promise<SessionLock | null> {
  const token = `${process.env.HOSTNAME ?? process.pid}:${randomUUID()}`;
  const key = lockKey(sessionId);
  const acquired = await redis.set(key, token, "PX", env.AGENT_SESSION_LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return null;

  let lock: LockDbLease | null = null;
  let physicalConnection: LockDbLease["connection"] | null = null;
  const [advisoryKey1, advisoryKey2] = advisoryKeys(sessionId);
  try {
    lock = await lockDbPool.acquire();
    physicalConnection = lock.connection;
    const connection = physicalConnection;
    const rows = await connection.unsafe<Array<{ locked: boolean }>>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [advisoryKey1, advisoryKey2],
    );
    if (rows[0]?.locked !== true) {
      await lock.release();
      lock = null;
      physicalConnection = null;
      await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
      return null;
    }
    const holderKind = options.holderKind ?? "cloud_agent";
    const holderId = options.holderId?.trim() || token;
    const expiresAt = new Date(Date.now() + env.AGENT_SESSION_LOCK_TTL_MS);
    const leaseRows = await connection.unsafe<Array<{ epoch: number | string }>>(
      `insert into v2.session_writer_leases
        (session_id, holder_kind, holder_id, epoch, expires_at, last_heartbeat_at, updated_at)
       values ($1, $2, $3, 1, $4, now(), now())
       on conflict (session_id) do update set
         holder_kind = excluded.holder_kind,
         holder_id = excluded.holder_id,
         epoch = v2.session_writer_leases.epoch + 1,
         expires_at = excluded.expires_at,
         last_heartbeat_at = now(),
         updated_at = now()
       returning epoch`,
      [sessionId, holderKind, holderId, expiresAt],
    );
    const epoch = Number(leaseRows[0]?.epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("session writer lease returned an invalid epoch");

    let closed = false;
    let heartbeatInFlight: Promise<void> | null = null;
    let heartbeatError: Error | null = null;
    let sqlConnectionHealthy = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let heartbeatFailureReported = false;
    const heartbeat = async () => {
      if (closed || !physicalConnection) return;
      const connection = physicalConnection;
      const nextExpiresAt = new Date(Date.now() + env.AGENT_SESSION_LOCK_TTL_MS);
      const redisResult = await redis.eval(RENEW_SCRIPT, 1, key, token, String(env.AGENT_SESSION_LOCK_TTL_MS));
      let leaseRows: Array<{ session_id: string }>;
      try {
        leaseRows = await connection.unsafe<Array<{ session_id: string }>>(
          `update v2.session_writer_leases
           set expires_at = $1, last_heartbeat_at = now(), updated_at = now()
           where session_id = $2 and holder_id = $3 and epoch = $4 and expires_at > now()
           returning session_id`,
          [nextExpiresAt, sessionId, holderId, epoch],
        );
      } catch (error) {
        sqlConnectionHealthy = false;
        throw error;
      }
      if (Number(redisResult) !== 1 || leaseRows.length !== 1) throw new Error("session writer lease was lost");
    };
    const runHeartbeat = () => {
      if (closed || heartbeatInFlight) return;
      const pending = heartbeat().catch((error) => {
        heartbeatError = error instanceof Error ? error : new Error(String(error));
        closed = true;
        if (timer) clearInterval(timer);
        logger.error(`[AgentLock] renew failed sessionId=${sessionId}:`, heartbeatError);
        if (!heartbeatFailureReported) {
          heartbeatFailureReported = true;
          options.onLost?.(heartbeatError);
        }
      }).finally(() => {
        if (heartbeatInFlight === pending) heartbeatInFlight = null;
      });
      heartbeatInFlight = pending;
    };
    timer = setInterval(runHeartbeat, env.AGENT_SESSION_LOCK_RENEW_INTERVAL_MS);
    timer.unref();

    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
    };

    return {
      sessionId,
      token,
      epoch,
      stop,
      assertHealthy: () => {
        if (heartbeatError) throw heartbeatError;
        if (closed) throw new Error("session writer lock is closed");
      },
      release: async () => {
        stop();
        const connection = physicalConnection;
        const currentLock = lock;
        physicalConnection = null;
        lock = null;
        let releaseError: unknown = null;
        if (connection && currentLock) {
          await heartbeatInFlight?.catch(() => undefined);
          let discard = !sqlConnectionHealthy;
          if (!discard) {
            try {
              await connection.unsafe(
                `update v2.session_writer_leases
                 set expires_at = now(), last_heartbeat_at = now(), updated_at = now()
                 where session_id = $1 and holder_id = $2 and epoch = $3`,
                [sessionId, holderId, epoch],
              );
            } catch (error) {
              discard = true;
              releaseError = error;
              logger.warn(`[AgentLock] durable lease release failed sessionId=${sessionId}:`, error);
            }
          }
          if (!discard) {
            try {
              const unlockRows = await connection.unsafe<Array<{ unlocked: boolean }>>(
                "select pg_advisory_unlock($1, $2) as unlocked",
                [advisoryKey1, advisoryKey2],
              );
              if (unlockRows[0]?.unlocked !== true) throw new Error("session_advisory_unlock_failed");
            } catch (error) {
              discard = true;
              releaseError = error;
              logger.error(`[AgentLock] advisory unlock failed; retiring lock connection sessionId=${sessionId}:`, error);
            }
          }
          try {
            if (discard) await currentLock.discard();
            else await currentLock.release();
          } catch (error) {
            releaseError ??= error;
            logger.error(`[AgentLock] lock connection cleanup failed sessionId=${sessionId}:`, error);
          }
        }
        await redis.eval(RELEASE_SCRIPT, 1, key, token).catch((error) => {
          logger.warn(`[AgentLock] Redis release failed sessionId=${sessionId}:`, error);
        });
        if (releaseError) {
          logger.error(`[AgentLock] session lock cleanup completed with an error sessionId=${sessionId}:`, releaseError);
        }
      },
    };
  } catch (error) {
    // Any failure after acquisition leaves the PostgreSQL session state
    // unknown; retire the slot rather than returning it to the lock pool.
    await lock?.discard();
    await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    throw error;
  }
}
