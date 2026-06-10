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

type AsrConnectionContext = {
  connectionId: string;
  userId?: string;
  token?: string;
  provider?: VolcAsrProvider;
  asrOptions?: ReturnType<typeof normalizeAsrSessionOptions>;
  telemetry?: AsrTelemetryState;
  messageQueue: Promise<void>;
  resultQueue: Promise<void>;
  committedText: string;
  partialText: string;
  timeout?: NodeJS.Timeout;
  idleTimeout?: NodeJS.Timeout;
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

const clearSessionTimeout = (ctx: AsrConnectionContext) => {
  if (ctx.timeout) clearTimeout(ctx.timeout);
  ctx.timeout = undefined;
};

const clearIdleTimeout = (ctx: AsrConnectionContext) => {
  if (ctx.idleTimeout) clearTimeout(ctx.idleTimeout);
  ctx.idleTimeout = undefined;
};

const scheduleIdleClose = (socket: WebSocket, ctx: AsrConnectionContext) => {
  clearIdleTimeout(ctx);
  if (ctx.provider) return;
  ctx.idleTimeout = setTimeout(() => {
    if (ctx.provider || socket.readyState !== WebSocket.OPEN) return;
    socket.close(1000, "asr connection idle timeout");
  }, ASR_IDLE_CONNECTION_MS);
};

const closeProvider = (ctx: AsrConnectionContext) => {
  clearSessionTimeout(ctx);
  const provider = ctx.provider;
  ctx.provider = undefined;
  provider?.close();
};

const markProviderClosed = (
  ctx: AsrConnectionContext,
  provider: VolcAsrProvider,
) => {
  if (ctx.provider !== provider) return;
  clearSessionTimeout(ctx);
  ctx.provider = undefined;
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
  ctx: AsrConnectionContext,
  input: {
    requestId: string;
    text: string;
    definite: boolean;
    options: ReturnType<typeof normalizeAsrSessionOptions>;
  },
) => {
  const rewrite = await rewriteAsrText(input.text, input.options, {
    llm: input.definite,
  });
  const text = rewrite.text;
  if (!text) return;
  recordAsrResult(ctx.telemetry, input.definite);
  if (input.definite) {
    ctx.committedText += text;
    ctx.partialText = "";
    send(socket, {
      type: "asr.final",
      requestId: input.requestId,
      payload: {
        text,
        fullText: ctx.committedText,
        originalText: rewrite.originalText,
        alternatives: rewrite.alternatives,
        rewritten: rewrite.rewritten,
      },
    });
    return;
  }
  ctx.partialText = text;
  send(socket, {
    type: "asr.partial",
    requestId: input.requestId,
    payload: {
      text,
      fullText: ctx.committedText + ctx.partialText,
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
  closeProvider(ctx);
  if (ctx.telemetry && !ctx.telemetry.emitted)
    emitAsrTelemetrySummary(
      logger,
      ctx.telemetry,
      ctx.asrOptions,
      "client_close",
    );
  ctx.committedText = "";
  ctx.partialText = "";

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
  ctx.asrOptions = asrOptions;
  ctx.telemetry = createAsrTelemetryState({
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
  ctx.provider = provider;

  provider.on("result", (result) => {
    ctx.resultQueue = ctx.resultQueue
      .then(() =>
        handleAsrResult(socket, ctx, {
          requestId,
          text: result.text,
          definite: result.definite,
          options: asrOptions,
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
    markAsrError(ctx.telemetry, {
      stage: "provider",
      code: error.message.slice(0, 80),
    });
    logger.warn("[ASR] provider error", {
      connectionId: ctx.connectionId,
      requestId,
      error: error.message,
    });
    sendError(
      socket,
      "PROVIDER_ERROR",
      "Voice input is unavailable. Try again later.",
      requestId,
    );
    if (ctx.provider === provider) {
      if (ctx.telemetry && !ctx.telemetry.stopAt)
        ctx.telemetry.stopAt = Date.now();
      closeProvider(ctx);
    }
  });
  provider.on("close", () => {
    markProviderClosed(ctx, provider);
    void ctx.resultQueue.finally(() => {
      if (ctx.telemetry) ctx.telemetry.doneAt = Date.now();
      emitAsrTelemetrySummary(
        logger,
        ctx.telemetry,
        ctx.asrOptions,
        ctx.telemetry?.stopReason ?? "done",
      );
      send(socket, { type: "asr.done", requestId });
      scheduleIdleClose(socket, ctx);
    });
  });

  if (ctx.telemetry) ctx.telemetry.providerStartAt = Date.now();
  await provider.start();
  if (ctx.telemetry) ctx.telemetry.providerReadyAt = Date.now();
  ctx.timeout = setTimeout(() => {
    if (ctx.telemetry) {
      ctx.telemetry.stopReason = "error";
      ctx.telemetry.stopAt = Date.now();
    }
    provider.stop();
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
  if (!ctx.provider) {
    sendError(
      socket,
      "ASR_NOT_STARTED",
      "asr session is not started",
      message.requestId,
    );
    return;
  }
  if (message.type === "asr.audio") {
    const audio = Buffer.from(message.payload.audio, "base64");
    recordAsrAudio(ctx.telemetry, audio.byteLength);
    ctx.provider.sendAudio(audio);
    return;
  }
  if (message.type === "asr.stop") {
    if (ctx.telemetry) {
      ctx.telemetry.stopReason = message.payload?.reason ?? "manual";
      ctx.telemetry.stopAt = Date.now();
    }
    ctx.provider.stop();
    clearSessionTimeout(ctx);
    return;
  }
  if (message.type === "asr.cancel") {
    if (ctx.telemetry) {
      ctx.telemetry.stopReason = message.payload?.reason ?? "cancel";
      ctx.telemetry.stopAt = Date.now();
    }
    closeProvider(ctx);
    emitAsrTelemetrySummary(logger, ctx.telemetry, ctx.asrOptions, "cancel");
    send(socket, { type: "asr.cancelled", requestId: message.requestId });
    scheduleIdleClose(socket, ctx);
  }
};

export const handleAsrWebSocketConnection = (socket: WebSocket) => {
  const ctx: AsrConnectionContext = {
    connectionId: randomUUID(),
    messageQueue: Promise.resolve(),
    resultQueue: Promise.resolve(),
    committedText: "",
    partialText: "",
  };
  send(socket, {
    type: "system.ready",
    payload: { connectionId: ctx.connectionId },
  });
  scheduleIdleClose(socket, ctx);

  const handleSocketMessage = async (data: RawData) => {
    try {
      const raw = parseRawMessage(data);
      const authParsed = authMessageSchema.safeParse(raw);
      if (authParsed.success) {
        const result: RealtimeAuthResult = await authenticateRealtimeToken({
          token: authParsed.data.payload.token,
        });
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

      if (!ctx.userId) {
        sendError(socket, "UNAUTHORIZED", "authentication required");
        return;
      }

      const parsed = asrMessageSchema.safeParse(raw);
      if (!parsed.success) {
        if (ctx.telemetry) ctx.telemetry.invalidMessages += 1;
        sendError(socket, "BAD_REQUEST", "invalid asr message");
        return;
      }
      await handleAsrMessage(socket, ctx, parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markAsrError(ctx.telemetry, {
        stage: "gateway",
        code:
          message === "message too large"
            ? "MESSAGE_TOO_LARGE"
            : "INTERNAL_ERROR",
      });
      logger.warn("[ASR] message handling failed", {
        connectionId: ctx.connectionId,
        error: message,
      });
      sendError(
        socket,
        message === "message too large"
          ? "MESSAGE_TOO_LARGE"
          : "INTERNAL_ERROR",
        message === "message too large"
          ? "Voice data is too large"
          : "Voice input is unavailable. Try again later",
      );
    }
  };

  socket.on("message", (data) => {
    ctx.messageQueue = ctx.messageQueue.then(() => handleSocketMessage(data));
    void ctx.messageQueue;
  });

  socket.on("close", (code) => {
    clearIdleTimeout(ctx);
    if (ctx.telemetry) {
      ctx.telemetry.closeCode = code;
      if (!ctx.telemetry.stopReason) ctx.telemetry.stopReason = "client_close";
    }
    closeProvider(ctx);
    emitAsrTelemetrySummary(
      logger,
      ctx.telemetry,
      ctx.asrOptions,
      "client_close",
    );
  });
  socket.on("error", () => {
    clearIdleTimeout(ctx);
    markAsrError(ctx.telemetry, { stage: "gateway", code: "SOCKET_ERROR" });
    closeProvider(ctx);
    emitAsrTelemetrySummary(logger, ctx.telemetry, ctx.asrOptions, "error");
  });
};
