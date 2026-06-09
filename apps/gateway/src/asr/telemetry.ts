import { createHash } from "node:crypto";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { Logger } from "@cohub/infra/logging";
import type { AsrSessionOptions } from "./options.js";

export type AsrStopReason =
  | "manual"
  | "hotkey_release"
  | "vad_endpoint"
  | "cancel"
  | "client_close"
  | "error"
  | "done";

export type AsrClientInfo = {
  sessionId: string | null;
  audioPipeline: string | null;
  vadEnabled: boolean | null;
};

export type AsrTelemetryState = {
  connectionId: string;
  requestId: string;
  userHash: string | null;
  client: AsrClientInfo;
  experiment: string | null;
  variant: string | null;
  startedAt: number;
  providerStartAt?: number;
  providerReadyAt?: number;
  firstAudioAt?: number;
  firstPartialAt?: number;
  firstFinalAt?: number;
  stopAt?: number;
  doneAt?: number;
  audioBytes: number;
  audioMessages: number;
  partialMessages: number;
  finalMessages: number;
  invalidMessages: number;
  providerErrors: number;
  closeCode?: number;
  stopReason: AsrStopReason | null;
  error?: {
    stage: "gateway" | "provider";
    code: string;
  };
  emitted: boolean;
  span: Span;
};

const tracer = trace.getTracer("cohub-gateway");

export const hashTelemetryId = (value: string | null | undefined) => {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
};

export const createAsrTelemetryState = (input: {
  connectionId: string;
  requestId: string;
  userId: string;
  client: AsrClientInfo;
  experiment?: string | null;
  variant?: string | null;
}): AsrTelemetryState => {
  const userHash = hashTelemetryId(input.userId);
  const span = tracer.startSpan("asr.voice_session", {
    attributes: {
      "asr.provider": "volc",
      "asr.model": "bigmodel",
      "asr.request_id": input.requestId,
      "asr.connection_id": input.connectionId,
      "asr.user_hash": userHash ?? "",
      "asr.client.session_hash": hashTelemetryId(input.client.sessionId) ?? "",
      "asr.client.audio_pipeline": input.client.audioPipeline ?? "",
      "asr.client.vad_enabled": input.client.vadEnabled ?? false,
      "asr.experiment": input.experiment ?? "",
      "asr.variant": input.variant ?? "",
    },
  });
  return {
    connectionId: input.connectionId,
    requestId: input.requestId,
    userHash,
    client: {
      ...input.client,
      sessionId: hashTelemetryId(input.client.sessionId),
    },
    experiment: input.experiment ?? null,
    variant: input.variant ?? null,
    startedAt: Date.now(),
    audioBytes: 0,
    audioMessages: 0,
    partialMessages: 0,
    finalMessages: 0,
    invalidMessages: 0,
    providerErrors: 0,
    stopReason: null,
    emitted: false,
    span,
  };
};

export const recordAsrAudio = (
  telemetry: AsrTelemetryState | undefined,
  byteLength: number,
) => {
  if (!telemetry) return;
  if (!telemetry.firstAudioAt) {
    telemetry.firstAudioAt = Date.now();
    telemetry.span.addEvent("asr.first_audio");
  }
  telemetry.audioBytes += byteLength;
  telemetry.audioMessages += 1;
};

export const recordAsrResult = (
  telemetry: AsrTelemetryState | undefined,
  definite: boolean,
) => {
  if (!telemetry) return;
  const now = Date.now();
  if (definite) {
    if (!telemetry.firstFinalAt) {
      telemetry.firstFinalAt = now;
      telemetry.span.addEvent("asr.first_final");
    }
    telemetry.finalMessages += 1;
    return;
  }
  if (!telemetry.firstPartialAt) {
    telemetry.firstPartialAt = now;
    telemetry.span.addEvent("asr.first_partial");
  }
  telemetry.partialMessages += 1;
};

export const markAsrError = (
  telemetry: AsrTelemetryState | undefined,
  input: { stage: "gateway" | "provider"; code: string },
) => {
  if (!telemetry) return;
  telemetry.error = input;
  if (input.stage === "provider") telemetry.providerErrors += 1;
  telemetry.stopReason = "error";
  telemetry.span.recordException(new Error(`${input.stage}:${input.code}`));
  telemetry.span.setStatus({ code: SpanStatusCode.ERROR, message: input.code });
};

export const emitAsrTelemetrySummary = (
  logger: Logger,
  telemetry: AsrTelemetryState | undefined,
  options: AsrSessionOptions | undefined,
  reason: AsrStopReason = "done",
) => {
  if (!telemetry || telemetry.emitted) return;
  const doneAt = telemetry.doneAt ?? Date.now();
  telemetry.doneAt = doneAt;
  telemetry.stopReason = telemetry.stopReason ?? reason;
  telemetry.emitted = true;
  telemetry.span.setAttributes({
    "asr.duration_ms": doneAt - telemetry.startedAt,
    "asr.audio_bytes": telemetry.audioBytes,
    "asr.audio_messages": telemetry.audioMessages,
    "asr.partial_messages": telemetry.partialMessages,
    "asr.final_messages": telemetry.finalMessages,
    "asr.invalid_messages": telemetry.invalidMessages,
    "asr.provider_errors": telemetry.providerErrors,
    "asr.stop_reason": telemetry.stopReason,
    "asr.close_code": telemetry.closeCode ?? 0,
    "asr.hotword_count": options?.hotwords.length ?? 0,
    "asr.context_enabled": Boolean(
      options?.contextText || (options?.contextMessages.length ?? 0) > 0,
    ),
    "asr.end_window_size_ms": options?.endWindowSizeMs ?? 0,
    "asr.force_to_speech_time_ms": options?.forceToSpeechTimeMs ?? 0,
    "asr.enable_nonstream": options?.enableNonstream ?? false,
    "asr.enable_punctuation": options?.enablePunctuation ?? false,
    "asr.enable_itn": options?.enableItn ?? false,
    "asr.enable_ddc": options?.enableDdc ?? false,
  });
  if (telemetry.stopReason !== "error")
    telemetry.span.setStatus({ code: SpanStatusCode.OK });
  telemetry.span.addEvent("asr.summary");
  telemetry.span.end();
  logger.info("[ASR] voice session summary", {
    event: "voice_session_summary",
    connectionId: telemetry.connectionId,
    requestId: telemetry.requestId,
    userHash: telemetry.userHash,
    client: telemetry.client,
    experiment: telemetry.experiment,
    variant: telemetry.variant,
    asr: options
      ? {
          provider: "volc",
          model: "bigmodel",
          endWindowSizeMs: options.endWindowSizeMs,
          forceToSpeechTimeMs: options.forceToSpeechTimeMs,
          enableNonstream: options.enableNonstream,
          enablePunctuation: options.enablePunctuation,
          enableItn: options.enableItn,
          enableDdc: options.enableDdc,
          hotwordCount: options.hotwords.length,
          contextEnabled: Boolean(
            options.contextText || options.contextMessages.length > 0,
          ),
          boostingTableConfigured: Boolean(
            options.boostingTableId || options.boostingTableName,
          ),
          correctTableConfigured: Boolean(
            options.correctTableId || options.correctTableName,
          ),
          postProcessing: options.postProcessing,
        }
      : null,
    timing: {
      durationMs: doneAt - telemetry.startedAt,
      ...(telemetry.providerStartAt && telemetry.providerReadyAt
        ? {
            providerConnectMs:
              telemetry.providerReadyAt - telemetry.providerStartAt,
          }
        : {}),
      ...(telemetry.firstAudioAt && telemetry.firstPartialAt
        ? {
            firstAudioToPartialMs:
              telemetry.firstPartialAt - telemetry.firstAudioAt,
          }
        : {}),
      ...(telemetry.firstAudioAt && telemetry.firstFinalAt
        ? {
            firstAudioToFinalMs:
              telemetry.firstFinalAt - telemetry.firstAudioAt,
          }
        : {}),
      ...(telemetry.stopAt ? { stopToDoneMs: doneAt - telemetry.stopAt } : {}),
    },
    traffic: {
      audioBytes: telemetry.audioBytes,
      audioMessages: telemetry.audioMessages,
      partialMessages: telemetry.partialMessages,
      finalMessages: telemetry.finalMessages,
      invalidMessages: telemetry.invalidMessages,
    },
    stopReason: telemetry.stopReason,
    closeCode: telemetry.closeCode,
    error: telemetry.error,
  });
};
