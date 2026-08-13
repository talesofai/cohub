import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { createLogger } from "@cohub/infra/logging";
import {
  acquireRealtimeVoiceSession,
  heartbeatRealtimeVoiceSession,
  releaseRealtimeVoiceSession,
} from "../api-client.js";
import { gatewayConfig } from "../config.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

const HEARTBEAT_INTERVAL_MS = 30_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Terminates the end user's realtime voice WebSocket at cohub (same shape as
 * asr/session.ts's ASR gateway), then relays raw bytes to neta-router's own
 * /v1/realtime, which in turn forwards to new-api. Bytes never transit through
 * neta-router's or new-api's protocol translation at this layer -- this is a
 * pure passthrough, same as neta-router's role for every other route.
 *
 * The wire protocol from the client's perspective is meant to look like a
 * normal OpenAI-realtime-compatible endpoint, so auth travels in the
 * handshake (x-token header for native clients, or a `x-token.<value>`
 * Sec-WebSocket-Protocol entry for browsers, which can't set custom headers
 * on a WebSocket) rather than as an in-band message the way asr/session.ts's
 * custom envelope protocol does it.
 */
export function handleRealtimeVoiceConnection(socket: WebSocket, request: IncomingMessage): void {
  void run(socket, request);
}

async function run(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const token = firstHeader(request.headers["x-token"]) ?? extractTokenFromSubprotocol(request.headers["sec-websocket-protocol"]);
  if (!token) {
    socket.close(4001, "missing x-token");
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const service = url.searchParams.get("calling") === "true" ? "realtime_calling" : "realtime_tts";

  let sessionId: string;
  let sessionConfig: { idle_timeout_s: number; max_duration_s: number };
  try {
    const acquired = await acquireRealtimeVoiceSession({ token, service });
    sessionId = acquired.session_id;
    sessionConfig = acquired.config;
    logger.info("[RealtimeVoice] session acquired", { service });
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : "session acquire failed";
    const code = status === 429 || status === 402 || status === 503 ? 4005 : 4001;
    trySend(socket, { type: "error", error: { message, code } });
    socket.close(code, message.slice(0, 120));
    return;
  }

  const netaRouter = gatewayConfig.netaRouter;
  const upstreamUrl = `${netaRouter.baseUrl.replace(/^http/, "ws")}/v1/realtime${url.search}`;

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(upstreamUrl, {
      headers: { Authorization: `Bearer ${netaRouter.apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("upstream connect timeout")), UPSTREAM_CONNECT_TIMEOUT_MS);
      upstream.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      upstream.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    logger.info("[RealtimeVoice] upstream connected", { sessionId });
  } catch (error) {
    logger.error("[RealtimeVoice] upstream connect failed", { sessionId, error });
    trySend(socket, { type: "error", error: { message: "upstream connection failed", code: 4006 } });
    socket.close(4006, "upstream connection failed");
    await releaseRealtimeVoiceSession(sessionId);
    return;
  }

  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    if (socket.readyState === WebSocket.OPEN) socket.close();
    await releaseRealtimeVoiceSession(sessionId).catch((error) => {
      logger.warn("[RealtimeVoice] session release failed", { sessionId, error });
    });
  };

  socket.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });
  upstream.on("message", (data, isBinary) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
  });
  socket.on("close", () => void cleanup());
  socket.on("error", (error) => {
    logger.warn("[RealtimeVoice] client error", { sessionId, error });
    void cleanup();
  });
  upstream.on("close", () => void cleanup());
  upstream.on("error", (error) => {
    logger.warn("[RealtimeVoice] upstream error", { sessionId, error });
    void cleanup();
  });

  const doHeartbeat = async () => {
    try {
      const result = await heartbeatRealtimeVoiceSession(sessionId);
      if (result.billing?.allowed === false) {
        logger.info("[RealtimeVoice] billing denied, closing session", { sessionId, reason: result.billing.reason });
        trySend(socket, { type: "error", error: { type: "billing_exhausted", message: result.billing.reason ?? "余额不足，会话结束" } });
        await cleanup();
      }
    } catch (error) {
      logger.error("[RealtimeVoice] heartbeat failed, closing session", { sessionId, error });
      await cleanup();
    }
  };
  void doHeartbeat();
  heartbeatTimer = setInterval(() => void doHeartbeat(), HEARTBEAT_INTERVAL_MS);

  // Backend session TTL is authoritative; this just avoids waiting up to
  // HEARTBEAT_INTERVAL_MS after expiry for the next heartbeat to notice.
  maxDurationTimer = setTimeout(() => {
    logger.info("[RealtimeVoice] max duration reached, closing session", { sessionId });
    trySend(socket, { type: "error", error: { type: "max_duration_reached", message: "会话已达最长时长，连接关闭" } });
    void cleanup();
  }, sessionConfig.max_duration_s * 1000);
}

function trySend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    logger.warn("[RealtimeVoice] failed to send error frame", { error });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  const trimmed = header?.trim();
  return trimmed || undefined;
}

function extractTokenFromSubprotocol(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw) return undefined;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("x-token.")) return trimmed.slice("x-token.".length);
  }
  return undefined;
}
