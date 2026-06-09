import { gatewayConfig } from "../config.js";

export type AsrPostProcessingOptions = {
  enabled: boolean;
  normalizeWhitespace: boolean;
  cleanupFillers: boolean;
  rewritePunctuation: boolean;
  applyContextTerms: boolean;
};

export type AsrSessionOptions = {
  language: string | null;
  endWindowSizeMs: number;
  forceToSpeechTimeMs: number;
  enableNonstream: boolean;
  enablePunctuation: boolean;
  enableItn: boolean;
  enableDdc: boolean;
  hotwords: string[];
  contextText: string | null;
  contextMessages: string[];
  boostingTableName: string | null;
  boostingTableId: string | null;
  correctTableName: string | null;
  correctTableId: string | null;
  postProcessing: AsrPostProcessingOptions;
};

export type AsrStartPayloadInput = {
  language?: string;
  asr?: {
    language?: string;
    endWindowSizeMs?: number;
    forceToSpeechTimeMs?: number;
    enableNonstream?: boolean;
    enablePunctuation?: boolean;
    enableItn?: boolean;
    enableDdc?: boolean;
    hotwords?: string[];
    contextText?: string;
    contextMessages?: string[];
    boostingTableName?: string;
    boostingTableId?: string;
    correctTableName?: string;
    correctTableId?: string;
    postProcessing?: Partial<AsrPostProcessingOptions>;
  };
};

const MAX_HOTWORDS = 80;
const MAX_HOTWORD_CHARS = 40;
const MAX_CONTEXT_CHARS = 1200;
const MAX_CONTEXT_MESSAGES = 12;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.trunc(value), min), max);

const textOrNull = (value: string | null | undefined, maxLength = 120) => {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
};

const normalizeHotwords = (values: string[] | undefined) => {
  if (!values) return [];
  const seen = new Set<string>();
  const hotwords: string[] = [];
  for (const value of values) {
    const word = value.replace(/\s+/g, " ").trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    hotwords.push(word.slice(0, MAX_HOTWORD_CHARS));
    if (hotwords.length >= MAX_HOTWORDS) break;
  }
  return hotwords;
};

const normalizeContextMessages = (values: string[] | undefined) => {
  if (!values) return [];
  const messages: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) continue;
    messages.push(text.slice(0, 240));
    if (messages.length >= MAX_CONTEXT_MESSAGES) break;
  }
  return messages;
};

export const normalizeAsrSessionOptions = (payload: AsrStartPayloadInput | undefined): AsrSessionOptions => {
  const input = payload?.asr;
  return {
    language: textOrNull(input?.language ?? payload?.language, 24),
    endWindowSizeMs: clamp(input?.endWindowSizeMs ?? gatewayConfig.volcAsr.endWindowSizeMs, 200, 3000),
    forceToSpeechTimeMs: clamp(input?.forceToSpeechTimeMs ?? gatewayConfig.volcAsr.forceToSpeechTimeMs, 1, 10_000),
    enableNonstream: input?.enableNonstream ?? gatewayConfig.volcAsr.enableNonstream,
    enablePunctuation: input?.enablePunctuation ?? gatewayConfig.volcAsr.enablePunctuation,
    enableItn: input?.enableItn ?? gatewayConfig.volcAsr.enableItn,
    enableDdc: input?.enableDdc ?? gatewayConfig.volcAsr.enableDdc,
    hotwords: normalizeHotwords(input?.hotwords),
    contextText: textOrNull(input?.contextText, MAX_CONTEXT_CHARS),
    contextMessages: normalizeContextMessages(input?.contextMessages),
    boostingTableName: textOrNull(input?.boostingTableName ?? gatewayConfig.volcAsr.boostingTableName, 120),
    boostingTableId: textOrNull(input?.boostingTableId ?? gatewayConfig.volcAsr.boostingTableId, 120),
    correctTableName: textOrNull(input?.correctTableName ?? gatewayConfig.volcAsr.correctTableName, 120),
    correctTableId: textOrNull(input?.correctTableId ?? gatewayConfig.volcAsr.correctTableId, 120),
    postProcessing: {
      enabled: input?.postProcessing?.enabled ?? true,
      normalizeWhitespace: input?.postProcessing?.normalizeWhitespace ?? true,
      cleanupFillers: input?.postProcessing?.cleanupFillers ?? true,
      rewritePunctuation: input?.postProcessing?.rewritePunctuation ?? true,
      applyContextTerms: input?.postProcessing?.applyContextTerms ?? true,
    },
  };
};

export const buildVolcCorpusContext = (options: AsrSessionOptions) => {
  const hotwordItems = options.hotwords.map((word) => ({ word }));
  const contextData = [
    ...options.contextMessages.map((text) => ({ text })),
    ...(options.contextText ? [{ text: options.contextText }] : []),
  ];

  if (hotwordItems.length === 0 && contextData.length === 0) return null;
  return JSON.stringify({
    ...(hotwordItems.length > 0 ? { hotwords: hotwordItems } : {}),
    ...(contextData.length > 0 ? { context_type: "dialog_ctx", context_data: contextData } : {}),
  });
};
