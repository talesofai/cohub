import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { createLogger } from "@cohub/infra/logging";
import {
  authenticateRealtimeToken,
  type RealtimeAuthResult,
} from "../api-client.js";
import { gatewayConfig } from "../config.js";
import { applyAsrExperiment } from "./experiments.js";
import {
  buildVolcCorpusContext,
  normalizeAsrSessionOptions,
} from "./options.js";
import { rewriteAsrText } from "./rewrite.js";
import {
  type AsrClientInfo,
  type AsrTelemetryState,
  createAsrTelemetryState,
  emitAsrTelemetrySummary,
  markAsrError,
  recordAsrAudio,
  recordAsrResult,
} from "./telemetry.js";
import { VolcAsrProvider } from "./volc-asr-provider.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

const ASR_MAX_MESSAGE_BYTES = 1024 * 1024;
const ASR_MAX_SESSION_MS = 10 * 60_000;
const ASR_IDLE_CONNECTION_MS = 30 * 60_000;
const ASR_STOP_FINALIZE_MS = 12_000;

const authMessageSchema = z.object({
  type: z.literal("auth"),
  requestId: z.string().optional(),
  payload: z.object({
    token: z.string().min(1),
  }),
});

const postProcessingSchema = z.object({
  enabled: z.boolean().optional(),
  normalizeWhitespace: z.boolean().optional(),
  cleanupFillers: z.boolean().optional(),
  rewritePunctuation: z.boolean().optional(),
  applyContextTerms: z.boolean().optional(),
});

const clientInfoSchema = z.object({
  sessionId: z.string().min(1).optional(),
  audioPipeline: z.string().min(1).optional(),
  vadEnabled: z.boolean().optional(),
});

const stopReasonSchema = z.enum([
  "manual",
  "hotkey_release",
  "vad_endpoint",
  "cancel",
  "client_close",
  "error",
]);

const asrOptionsSchema = z.object({
  language: z.string().min(1).optional(),
  endWindowSizeMs: z.number().int().optional(),
  forceToSpeechTimeMs: z.number().int().optional(),
  enableNonstream: z.boolean().optional(),
  enablePunctuation: z.boolean().optional(),
  enableItn: z.boolean().optional(),
  enableDdc: z.boolean().optional(),
  hotwords: z.array(z.string().min(1)).optional(),
  contextText: z.string().optional(),
  contextMessages: z.array(z.string()).optional(),
  boostingTableName: z.string().optional(),
  boostingTableId: z.string().optional(),
  correctTableName: z.string().optional(),
  correctTableId: z.string().optional(),
  postProcessing: postProcessingSchema.optional(),
});

const asrMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("asr.start"),
    requestId: z.string().optional(),
    payload: z
      .object({
        language: z.string().min(1).optional(),
        asr: asrOptionsSchema.optional(),
        client: clientInfoSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("asr.audio"),
    requestId: z.string().optional(),
    payload: z.object({
      audio: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("asr.stop"),
    requestId: z.string().optional(),
    payload: z
      .object({
        reason: stopReasonSchema.optional(),
        clientSessionId: z.string().optional().nullable(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("asr.cancel"),
    requestId: z.string().optional(),
    payload: z
      .object({
        reason: stopReasonSchema.optional(),
        clientSessionId: z.string().optional().nullable(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("ping"),
    requestId: z.string().optional(),
  }),
]);

type AsrMessage = z.infer<typeof asrMessageSchema>;

type NormalizedAsrSessionOptions = ReturnType<typeof normalizeAsrSessionOptions>;

type AsrSessionState = {
  requestId: string;
  provider: VolcAsrProvider;
  asrOptions: NormalizedAsrSessionOptions;
  telemetry: AsrTelemetryState;
  resultQueue: Promise<void>;
  committedText: string;
  partialText: string;
  timeout?: NodeJS.Timeout;
  stopTimeout?: NodeJS.Timeout;
  finalized?: boolean;
  discardResults?: boolean;
};

type AsrConnectionContext = {
  connectionId: string;
  userId?: string;
  token?: string;
  activeSession?: AsrSessionState;
  messageQueue: Promise<void>;
  idleTimeout?: NodeJS.Timeout;
  closed?: boolean;
};

const send = (
  socket: WebSocket,
  input: {
    type: string;
    requestId?: string | null;
    payload?: Record<string, unknown>;
  },
) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(
      JSON.stringify({
        id: randomUUID(),
        timestamp: Date.now(),
        requestId: input.requestId ?? null,
        type: input.type,
        payload: input.payload ?? {},
      }),
    );
  } catch (error) {
    logger.warn("[ASR] failed to send websocket message", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const sendError = (
  socket: WebSocket,
  code: string,
  message: string,
  requestId?: string | null,
) => {
  send(socket, { type: "asr.error", requestId, payload: { code, message } });
};

const parseRawMessage = (data: RawData) => {
  const raw =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf-8")
        : Array.isArray(data)
          ? Buffer.concat(
              data.map((chunk) =>
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
              ),
            ).toString("utf-8")
          : Buffer.from(data).toString("utf-8");
  if (Buffer.byteLength(raw, "utf-8") > ASR_MAX_MESSAGE_BYTES) {
    throw new Error("message too large");
  }
  return JSON.parse(raw) as unknown;
};

const getVolcConfig = () => {
  const apiKey = gatewayConfig.volcAsr.apiKey;
  if (!apiKey) throw new Error("VOLC_ASR_API_KEY is not configured");
  return {
    apiKey,
    resourceId: gatewayConfig.volcAsr.resourceId,
    url: gatewayConfig.volcAsr.url,
  };
};

const clearSessionTimeout = (session: AsrSessionState | undefined) => {
  if (session?.timeout) clearTimeout(session.timeout);
  if (session) session.timeout = undefined;
};

const clearStopTimeout = (session: AsrSessionState | undefined) => {
  if (session?.stopTimeout) clearTimeout(session.stopTimeout);
  if (session) session.stopTimeout = undefined;
};

const clearSessionTimers = (session: AsrSessionState | undefined) => {
  clearSessionTimeout(session);
  clearStopTimeout(session);
};

const clearIdleTimeout = (ctx: AsrConnectionContext) => {
  if (ctx.idleTimeout) clearTimeout(ctx.idleTimeout);
  ctx.idleTimeout = undefined;
};

const scheduleIdleClose = (socket: WebSocket, ctx: AsrConnectionContext) => {
  clearIdleTimeout(ctx);
  if (ctx.closed || ctx.activeSession) return;
  ctx.idleTimeout = setTimeout(() => {
    if (ctx.closed || ctx.activeSession || socket.readyState !== WebSocket.OPEN)
      return;
    socket.close(1000, "asr connection idle timeout");
  }, ASR_IDLE_CONNECTION_MS);
};

const isConnectionClosed = (socket: WebSocket, ctx: AsrConnectionContext) =>
  ctx.closed === true || socket.readyState !== WebSocket.OPEN;

const closeSession = (
  ctx: AsrConnectionContext,
  session = ctx.activeSession,
) => {
  if (!session) return;
  session.finalized = true;
  session.discardResults = true;
  clearSessionTimers(session);
  if (ctx.activeSession === session) ctx.activeSession = undefined;
  session.provider.close();
};

const markSessionClosed = (
  ctx: AsrConnectionContext,
  session: AsrSessionState,
) => {
  if (ctx.activeSession !== session) return;
  clearSessionTimers(session);
  ctx.activeSession = undefined;
};

const finalizeSession = (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  session: AsrSessionState,
  reason = session.telemetry.stopReason ?? "done",
) => {
  if (session.finalized) return;
  session.finalized = true;
  markSessionClosed(ctx, session);
  void session.resultQueue.finally(() => {
    session.telemetry.doneAt = Date.now();
    emitAsrTelemetrySummary(logger, session.telemetry, session.asrOptions, reason);
    send(socket, { type: "asr.done", requestId: session.requestId });
    scheduleIdleClose(socket, ctx);
  });
};

const scheduleStopFinalize = (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  session: AsrSessionState,
) => {
  clearSessionTimeout(session);
  clearStopTimeout(session);
  session.stopTimeout = setTimeout(() => {
    if (ctx.activeSession !== session || session.finalized) return;
    logger.warn("[ASR] provider did not close after stop; finalizing session", {
      connectionId: ctx.connectionId,
      requestId: session.requestId,
      stopReason: session.telemetry.stopReason,
    });
    session.provider.close();
    finalizeSession(
      socket,
      ctx,
      session,
      session.telemetry.stopReason ?? "manual",
    );
  }, ASR_STOP_FINALIZE_MS);
};

const failProviderSession = (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  session: AsrSessionState,
  error: Error,
) => {
  if (ctx.activeSession !== session) return;
  markAsrError(session.telemetry, {
    stage: "provider",
    code: error.message.slice(0, 80),
  });
  logger.warn("[ASR] provider error", {
    connectionId: ctx.connectionId,
    requestId: session.requestId,
    error: error.message,
  });
  sendError(
    socket,
    "PROVIDER_ERROR",
    "Voice input is unavailable. Try again later.",
    session.requestId,
  );
  if (!session.telemetry.stopAt) session.telemetry.stopAt = Date.now();
  closeSession(ctx, session);
  emitAsrTelemetrySummary(logger, session.telemetry, session.asrOptions, "error");
  scheduleIdleClose(socket, ctx);
};

const failGatewaySession = (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  session: AsrSessionState,
  code: string,
  message: string,
) => {
  markAsrError(session.telemetry, { stage: "gateway", code });
  sendError(socket, code, message, session.requestId);
  if (!session.telemetry.stopAt) session.telemetry.stopAt = Date.now();
  closeSession(ctx, session);
  emitAsrTelemetrySummary(logger, session.telemetry, session.asrOptions, "error");
  scheduleIdleClose(socket, ctx);
};

const resolveClientInfo = (
  message: Extract<AsrMessage, { type: "asr.start" }>,
): AsrClientInfo => ({
  sessionId: message.payload?.client?.sessionId ?? null,
  audioPipeline: message.payload?.client?.audioPipeline ?? null,
  vadEnabled: message.payload?.client?.vadEnabled ?? null,
});

const handleAsrResult = async (
  socket: WebSocket,
  session: AsrSessionState,
  input: {
    text: string;
    definite: boolean;
  },
) => {
  if (session.discardResults) return;
  const rewrite = await rewriteAsrText(input.text, session.asrOptions, {
    llm: input.definite,
  });
  if (session.discardResults) return;
  const text = rewrite.text;
  if (!text) return;
  recordAsrResult(session.telemetry, input.definite);
  if (input.definite) {
    session.committedText += text;
    session.partialText = "";
    send(socket, {
      type: "asr.final",
      requestId: session.requestId,
      payload: {
        text,
        fullText: session.committedText,
        originalText: rewrite.originalText,
        alternatives: rewrite.alternatives,
        rewritten: rewrite.rewritten,
      },
    });
    return;
  }
  session.partialText = text;
  send(socket, {
    type: "asr.partial",
    requestId: session.requestId,
    payload: {
      text,
      fullText: session.committedText + session.partialText,
      originalText: rewrite.originalText,
      alternatives: rewrite.alternatives,
      rewritten: rewrite.rewritten,
    },
  });
};

const startAsr = async (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  message: Extract<AsrMessage, { type: "asr.start" }>,
) => {
  if (isConnectionClosed(socket, ctx)) return;
  if (!ctx.userId) {
    sendError(
      socket,
      "UNAUTHORIZED",
      "authentication required",
      message.requestId,
    );
    return;
  }
  clearIdleTimeout(ctx);
  if (isConnectionClosed(socket, ctx)) return;
  const replacedSession = ctx.activeSession;
  if (replacedSession) {
    if (!replacedSession.telemetry.stopReason) {
      replacedSession.telemetry.stopReason = "client_close";
      replacedSession.telemetry.stopAt = Date.now();
    }
    send(socket, {
      type: "asr.cancelled",
      requestId: replacedSession.requestId,
    });
    closeSession(ctx, replacedSession);
    emitAsrTelemetrySummary(
      logger,
      replacedSession.telemetry,
      replacedSession.asrOptions,
      replacedSession.telemetry.stopReason ?? "client_close",
    );
  }

  const volcConfig = getVolcConfig();
  const requestId = message.requestId ?? randomUUID();
  const selection = applyAsrExperiment(
    normalizeAsrSessionOptions(message.payload),
    {
      experimentName: gatewayConfig.volcAsr.experimentName,
      variants: gatewayConfig.volcAsr.experimentVariants,
      userId: ctx.userId,
      requestId,
    },
  );
  const asrOptions = selection.options;
  const corpusContext = buildVolcCorpusContext(asrOptions);
  const telemetry = createAsrTelemetryState({
    connectionId: ctx.connectionId,
    requestId,
    userId: ctx.userId,
    client: resolveClientInfo(message),
    experiment: selection.experiment,
    variant: selection.variant,
  });
  const provider = new VolcAsrProvider({
    ...volcConfig,
    requestId,
    uid: ctx.userId,
    requestConfig: {
      language: asrOptions.enableNonstream ? null : asrOptions.language,
      endWindowSizeMs: asrOptions.endWindowSizeMs,
      forceToSpeechTimeMs: asrOptions.forceToSpeechTimeMs,
      enableNonstream: asrOptions.enableNonstream,
      enablePunctuation: asrOptions.enablePunctuation,
      enableItn: asrOptions.enableItn,
      enableDdc: asrOptions.enableDdc,
      corpus: {
        boostingTableName: asrOptions.boostingTableName,
        boostingTableId: asrOptions.boostingTableId,
        correctTableName: asrOptions.correctTableName,
        correctTableId: asrOptions.correctTableId,
        context: corpusContext,
      },
    },
  });
  const session: AsrSessionState = {
    requestId,
    provider,
    asrOptions,
    telemetry,
    resultQueue: Promise.resolve(),
    committedText: "",
    partialText: "",
  };
  ctx.activeSession = session;
  if (isConnectionClosed(socket, ctx)) {
    closeSession(ctx, session);
    emitAsrTelemetrySummary(logger, telemetry, asrOptions, "client_close");
    return;
  }

  provider.on("result", (result) => {
    if (ctx.activeSession !== session || session.discardResults) return;
    session.resultQueue = session.resultQueue
      .then(() =>
        handleAsrResult(socket, session, {
          text: result.text,
          definite: result.definite,
        }),
      )
      .catch((error) => {
        logger.warn("[ASR] rewrite failed", {
          connectionId: ctx.connectionId,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  provider.on("error", (error) => {
    failProviderSession(socket, ctx, session, error);
  });
  provider.on("close", () => {
    finalizeSession(socket, ctx, session);
  });

  session.telemetry.providerStartAt = Date.now();
  try {
    await provider.start();
  } catch (error) {
    failProviderSession(
      socket,
      ctx,
      session,
      error instanceof Error ? error : new Error(String(error)),
    );
    return;
  }
  if (ctx.activeSession !== session || isConnectionClosed(socket, ctx)) {
    if (!session.finalized) {
      closeSession(ctx, session);
      emitAsrTelemetrySummary(logger, telemetry, asrOptions, "client_close");
    } else {
      provider.close();
    }
    return;
  }
  session.telemetry.providerReadyAt = Date.now();
  session.timeout = setTimeout(() => {
    if (ctx.activeSession !== session) return;
    session.telemetry.stopReason = "error";
    session.telemetry.stopAt = Date.now();
    provider.stop();
    scheduleStopFinalize(socket, ctx, session);
    sendError(
      socket,
      "MAX_DURATION_EXCEEDED",
      "Voice input reached the time limit",
      requestId,
    );
  }, ASR_MAX_SESSION_MS);
  send(socket, {
    type: "asr.started",
    requestId,
    payload: {
      endpoint: {
        endWindowSizeMs: asrOptions.endWindowSizeMs,
        forceToSpeechTimeMs: asrOptions.forceToSpeechTimeMs,
      },
      hotwordCount: asrOptions.hotwords.length,
      contextEnabled: Boolean(corpusContext),
      postProcessing: asrOptions.postProcessing,
      experiment: selection.experiment,
      variant: selection.variant,
    },
  });
};

const handleAsrMessage = async (
  socket: WebSocket,
  ctx: AsrConnectionContext,
  message: AsrMessage,
) => {
  if (message.type === "ping") {
    send(socket, { type: "pong", requestId: message.requestId });
    return;
  }
  if (message.type === "asr.start") {
    await startAsr(socket, ctx, message);
    return;
  }
  const session = ctx.activeSession;
  if (!session) {
    sendError(
      socket,
      "ASR_NOT_STARTED",
      "asr session is not started",
      message.requestId,
    );
    return;
  }
  if (message.requestId && message.requestId !== session.requestId) return;
  if (message.type === "asr.audio") {
    const audio = Buffer.from(message.payload.audio, "base64");
    recordAsrAudio(session.telemetry, audio.byteLength);
    session.provider.sendAudio(audio);
    return;
  }
  if (message.type === "asr.stop") {
    session.telemetry.stopReason = message.payload?.reason ?? "manual";
    session.telemetry.stopAt = Date.now();
    session.provider.stop();
    scheduleStopFinalize(socket, ctx, session);
    return;
  }
  if (message.type === "asr.cancel") {
    session.telemetry.stopReason = message.payload?.reason ?? "cancel";
    session.telemetry.stopAt = Date.now();
    closeSession(ctx, session);
    emitAsrTelemetrySummary(logger, session.telemetry, session.asrOptions, "cancel");
    send(socket, { type: "asr.cancelled", requestId: message.requestId });
    scheduleIdleClose(socket, ctx);
  }
};

export const handleAsrWebSocketConnection = (socket: WebSocket) => {
  const ctx: AsrConnectionContext = {
    connectionId: randomUUID(),
    messageQueue: Promise.resolve(),
  };
  send(socket, {
    type: "system.ready",
    payload: { connectionId: ctx.connectionId },
  });
  scheduleIdleClose(socket, ctx);

  const handleSocketMessage = async (data: RawData) => {
    try {
      if (isConnectionClosed(socket, ctx)) return;
      const raw = parseRawMessage(data);
      const authParsed = authMessageSchema.safeParse(raw);
      if (authParsed.success) {
        const result: RealtimeAuthResult = await authenticateRealtimeToken({
          token: authParsed.data.payload.token,
        });
        if (isConnectionClosed(socket, ctx)) return;
        if (!result.ok) {
          sendError(
            socket,
            "UNAUTHORIZED",
            result.error.message,
            authParsed.data.requestId,
          );
          return;
        }
        ctx.userId = result.user.uuid;
        ctx.token = authParsed.data.payload.token;
        send(socket, {
          type: "system.auth.ok",
          requestId: authParsed.data.requestId,
          payload: { user: result.user },
        });
        return;
      }

      if (isConnectionClosed(socket, ctx)) return;
      if (!ctx.userId) {
        sendError(socket, "UNAUTHORIZED", "authentication required");
        return;
      }

      const parsed = asrMessageSchema.safeParse(raw);
      if (!parsed.success) {
        const session = ctx.activeSession;
        if (session) {
          session.telemetry.invalidMessages += 1;
          failGatewaySession(
            socket,
            ctx,
            session,
            "BAD_REQUEST",
            "invalid asr message",
          );
          return;
        }
        sendError(socket, "BAD_REQUEST", "invalid asr message");
        return;
      }
      if (isConnectionClosed(socket, ctx)) return;
      await handleAsrMessage(socket, ctx, parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        message === "message too large" ? "MESSAGE_TOO_LARGE" : "INTERNAL_ERROR";
      const clientMessage =
        message === "message too large"
          ? "Voice data is too large"
          : "Voice input is unavailable. Try again later";
      logger.warn("[ASR] message handling failed", {
        connectionId: ctx.connectionId,
        error: message,
      });
      const session = ctx.activeSession;
      if (session) {
        failGatewaySession(socket, ctx, session, code, clientMessage);
        return;
      }
      sendError(socket, code, clientMessage);
    }
  };

  socket.on("message", (data) => {
    if (ctx.closed) return;
    ctx.messageQueue = ctx.messageQueue.then(() => handleSocketMessage(data));
    void ctx.messageQueue;
  });

  socket.on("close", (code) => {
    ctx.closed = true;
    clearIdleTimeout(ctx);
    const session = ctx.activeSession;
    if (session) {
      session.telemetry.closeCode = code;
      if (!session.telemetry.stopReason)
        session.telemetry.stopReason = "client_close";
    }
    closeSession(ctx, session);
    emitAsrTelemetrySummary(
      logger,
      session?.telemetry,
      session?.asrOptions,
      "client_close",
    );
  });
  socket.on("error", () => {
    ctx.closed = true;
    clearIdleTimeout(ctx);
    const session = ctx.activeSession;
    markAsrError(session?.telemetry, { stage: "gateway", code: "SOCKET_ERROR" });
    closeSession(ctx, session);
    emitAsrTelemetrySummary(
      logger,
      session?.telemetry,
      session?.asrOptions,
      "error",
    );
  });
};
