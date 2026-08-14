import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  BillingAccessBlockedError,
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  REALTIME_VOICE_BILLING,
  billingOperations,
  createBillingUsageGate,
  isBillingUsageGateUnavailableError,
} from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { ensureInternalRequest, getOptionalAuth } from "../../lib/middleware.js";
import { billingBlockedResponse } from "../../lib/billing-blocked.js";
import {
  createRealtimeVoiceSessionTicket,
  verifyRealtimeVoiceSessionTicket,
  type RealtimeVoiceService,
} from "../../realtime-voice-tickets.js";

// Internal API consumed by neta-router's WebSocket relay (GET /v1/realtime),
// not by browsers directly. neta-router forwards the end user's own Logto
// access token as a normal Authorization header on acquire, so the existing
// global auth middleware resolves it into `principal` the same way it does
// for every other route; ensureInternalRequest additionally proves the
// caller is neta-router itself (x-worker-secret), not an arbitrary client.
//
// acquire/heartbeat/release are intentionally stateless on this side: the
// session's identity travels inside the signed `session_id` ticket
// (realtime-voice-tickets.ts) instead of a DB row, so heartbeat/release only
// need to verify a signature, not look anything up.
//
// Billing model: realtime voice has no natural per-task cost the way
// generation does (it's a continuous connection, not a discrete job), so it's
// billed as wall-clock connected time — a flat per-heartbeat-tick charge —
// rather than off provider-reported token usage. See REALTIME_VOICE_BILLING;
// its rate is a placeholder pending real pricing input.

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const IDLE_TIMEOUT_S = 60;
// TODO(product): confirm the intended max realtime-voice session length.
const MAX_DURATION_S = 30 * 60;
// Ticket must outlive the session it authorizes, with slack for the last heartbeat's round trip.
const TICKET_TTL_MS = (MAX_DURATION_S + IDLE_TIMEOUT_S + 60) * 1000;

const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    logger.warn("[BillingGate] realtime voice billing evaluation failed", { error, gateInput });
  },
});

function parseService(value: unknown): RealtimeVoiceService {
  return value === "realtime_calling" ? "realtime_calling" : "realtime_tts";
}

router.post("/session/acquire", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const user = getOptionalAuth(c);
  if (!user) return c.json({ detail: "authentication is required" }, 401);

  const body = await c.req.json<{ service?: string }>().catch(() => null);
  const service = parseService(body?.service);

  let decision: Awaited<ReturnType<typeof billingUsageGate.evaluate>>;
  try {
    decision = await billingUsageGate.evaluate({
      userId: user.uuid,
      usageKind: COHUB_BILLING_USAGE_TYPES.realtimeVoice,
      source: "realtime_session",
    });
  } catch (error) {
    if (!isBillingUsageGateUnavailableError(error)) throw error;
    return c.json({ detail: error.message }, 503);
  }
  if (decision.status === "blocked") {
    return billingBlockedResponse(c, new BillingAccessBlockedError(decision));
  }

  const sid = randomUUID();
  const expiresAt = Date.now() + TICKET_TTL_MS;
  const sessionId = createRealtimeVoiceSessionTicket({ userUuid: user.uuid, service, sid, expiresAt });

  logger.info("[RealtimeVoice] session acquired", { userUuid: user.uuid, service, sid });

  return c.json({
    session_id: sessionId,
    user_uuid: user.uuid,
    config: {
      idle_timeout_s: IDLE_TIMEOUT_S,
      max_duration_s: MAX_DURATION_S,
    },
  });
});

router.post("/session/heartbeat", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{ session_id?: string }>().catch(() => null);
  const ticket = typeof body?.session_id === "string" ? verifyRealtimeVoiceSessionTicket(body.session_id) : null;
  if (!ticket) return c.json({ detail: "invalid or expired session" }, 404);

  let decision: Awaited<ReturnType<typeof billingUsageGate.evaluate>>;
  try {
    decision = await billingUsageGate.evaluate({
      userId: ticket.userUuid,
      usageKind: COHUB_BILLING_USAGE_TYPES.realtimeVoice,
      source: "realtime_session",
      sessionId: ticket.sid,
    });
  } catch (error) {
    // Fail closed: an unreadable balance is treated the same as no balance,
    // rather than letting the session run un-metered.
    logger.warn("[RealtimeVoice] heartbeat billing gate unavailable, closing session", { error, sid: ticket.sid });
    return c.json({ success: true, billing: { allowed: false, reason: "billing temporarily unavailable" } });
  }
  if (decision.status === "blocked") {
    return c.json({ success: true, billing: { allowed: false, reason: "insufficient balance" } });
  }

  const amountUsd = Number(
    ((REALTIME_VOICE_BILLING.usdPerMinute / 60) * REALTIME_VOICE_BILLING.heartbeatIntervalSeconds).toFixed(8),
  );
  const tickBucket = Math.floor(Date.now() / (REALTIME_VOICE_BILLING.heartbeatIntervalSeconds * 1000));
  let charged = 0;
  try {
    const result = await billingOperations.recordUsage({
      userId: ticket.userUuid,
      amountUsd,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: COHUB_BILLING_USAGE_TYPES.realtimeVoice,
      sourceId: ticket.sid,
      // Idempotency key covers this session + this ~30s tick, so a client
      // retry of the same heartbeat can never double-charge.
      operationId: `realtime_voice:${ticket.sid}:${tickBucket}`,
      reason: `Realtime voice (${ticket.service})`,
    });
    if (result.status === "recorded" || result.status === "overage") charged = amountUsd;
  } catch (error) {
    // A transient billing-write failure doesn't kill the session — the
    // preflight gate above is what actually protects against runaway debt.
    logger.error("[RealtimeVoice] failed to record heartbeat usage", { error, sid: ticket.sid });
  }

  return c.json({
    success: true,
    billing: {
      allowed: true,
      charged,
      remaining_usd: decision.status === "allowed" || decision.status === "allowed_with_debt" ? decision.netUsd : undefined,
    },
  });
});

router.delete("/session/:sessionId", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const ticket = verifyRealtimeVoiceSessionTicket(c.req.param("sessionId"));
  if (ticket) {
    logger.info("[RealtimeVoice] session released", { userUuid: ticket.userUuid, sid: ticket.sid });
  }
  return c.json({ ok: true });
});

export default router;
