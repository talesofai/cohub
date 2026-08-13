import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Opaque session id for the realtime-voice internal API (see
 * routes/internal/realtime-voice.route.ts). Signed the same way as work room
 * tickets (work-realtime-rooms.ts) so acquire/heartbeat/release stay stateless:
 * the session's identity travels inside the token itself instead of a DB row,
 * and heartbeat/release only need to verify the signature, not look anything up.
 */

const ticketBase64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const ticketSecret = () => {
  if (!config.appEncryptionKey) throw new Error("Missing APP_ENCRYPTION_KEY for realtime voice session tickets");
  return config.appEncryptionKey;
};
const ticketSignature = (value: string) => createHmac("sha256", ticketSecret()).update(value).digest();

export type RealtimeVoiceService = "realtime_calling" | "realtime_tts";

export type RealtimeVoiceSessionTicketPayload = {
  typ: "realtime_voice_session";
  userUuid: string;
  service: RealtimeVoiceService;
  /** Random per-session id, used only for logging/idempotency, not as a lookup key. */
  sid: string;
  exp: number;
};

export const createRealtimeVoiceSessionTicket = (input: {
  userUuid: string;
  service: RealtimeVoiceService;
  sid: string;
  expiresAt: number;
}) => {
  const payload: RealtimeVoiceSessionTicketPayload = {
    typ: "realtime_voice_session",
    userUuid: input.userUuid,
    service: input.service,
    sid: input.sid,
    exp: Math.floor(input.expiresAt / 1000),
  };
  const header = ticketBase64(JSON.stringify({ alg: "HS256", typ: "COHUB_REALTIME_VOICE" }));
  const body = ticketBase64(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${ticketBase64(ticketSignature(signingInput))}`;
};

export const verifyRealtimeVoiceSessionTicket = (token: string): RealtimeVoiceSessionTicketPayload | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = ticketSignature(`${header}.${body}`);
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RealtimeVoiceSessionTicketPayload;
    if (
      payload.typ !== "realtime_voice_session" ||
      !payload.userUuid ||
      !payload.sid ||
      (payload.service !== "realtime_calling" && payload.service !== "realtime_tts") ||
      !Number.isInteger(payload.exp) ||
      payload.exp * 1000 <= Date.now()
    ) return null;
    return payload;
  } catch {
    return null;
  }
};
