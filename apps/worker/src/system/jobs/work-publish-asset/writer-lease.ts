import { randomUUID } from "node:crypto";
import { config } from "../../../config.js";
import {
  assertWorkAssetWriterLeaseResponse,
  getWorkAssetWriterLeaseExpiresAt,
  isWorkAssetWriterLeaseUsable,
} from "./writer-lease-response.js";

const MIN_WRITER_LEASE_REMAINING_MS = 70_000;
const WRITER_LEASE_REQUEST_TIMEOUT_MS = 10_000;

async function requestWriterLease(
  action: "acquire" | "heartbeat" | "release",
  input: { publishJobId: string; writerId: string },
) {
  const requestedAt = Date.now();
  const response = await fetch(`${config.internalApiBaseUrl}/internal/works/writer-lease/${action}`, {
    method: "POST",
    signal: AbortSignal.timeout(WRITER_LEASE_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": config.workerSecret,
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`work asset writer lease ${action} failed with status ${response.status}: ${text}`);
  const result: unknown = JSON.parse(text);
  if (action === "release") {
    if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
      throw new Error("work asset writer lease release returned an invalid response");
    }
    return { ok: true as const, leaseMs: 0, leaseExpiresAt: 0 };
  }
  const lease = assertWorkAssetWriterLeaseResponse(result);
  return {
    ...lease,
    leaseExpiresAt: getWorkAssetWriterLeaseExpiresAt(requestedAt, lease.leaseMs),
  };
}

export async function startWorkAssetWriterLease(publishJobId: string) {
  const writerId = randomUUID();
  const acquired = await requestWriterLease("acquire", { publishJobId, writerId });
  let healthy = true;
  let stopped = false;
  let leaseExpiresAt = acquired.leaseExpiresAt;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  const heartbeatMs = Math.max(1_000, Math.floor(acquired.leaseMs / 4));

  const timer = setInterval(() => {
    if (stopped) return;
    heartbeatInFlight = requestWriterLease("heartbeat", { publishJobId, writerId })
      .then((heartbeat) => {
        leaseExpiresAt = Math.max(leaseExpiresAt, heartbeat.leaseExpiresAt);
      })
      .catch((error) => {
        healthy = false;
        throw error;
      });
    heartbeatInFlight.catch(() => undefined);
  }, heartbeatMs);
  timer.unref();

  return {
    assertHealthy() {
      if (
        !healthy ||
        !isWorkAssetWriterLeaseUsable(
          leaseExpiresAt,
          Date.now(),
          MIN_WRITER_LEASE_REMAINING_MS,
        )
      ) {
        throw new Error("work asset writer lease was lost");
      }
    },
    async release() {
      stopped = true;
      clearInterval(timer);
      await heartbeatInFlight.catch(() => undefined);
      await requestWriterLease("release", { publishJobId, writerId });
    },
  };
}
