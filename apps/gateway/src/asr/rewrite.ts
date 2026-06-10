import { gatewayConfig } from "../config.js";
import type { AsrSessionOptions } from "./options.js";
import { postprocessAsrText } from "./postprocess.js";

export type AsrRewriteResult = {
  text: string;
  originalText: string;
  alternatives: string[];
  rewritten: boolean;
};

const stripCodeFence = (value: string) =>
  value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

const normalizeAlternative = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const parseRewriteResponse = (
  raw: unknown,
): { text: string; alternatives: string[] } | null => {
  if (!raw || typeof raw !== "object") return null;
  const choices = (raw as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  const content =
    message && typeof message === "object"
      ? (message as { content?: unknown }).content
      : null;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(stripCodeFence(content)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const text = normalizeAlternative((parsed as { text?: unknown }).text);
    const alternatives = Array.isArray(
      (parsed as { alternatives?: unknown }).alternatives,
    )
      ? (parsed as { alternatives: unknown[] }).alternatives
          .map(normalizeAlternative)
          .filter(Boolean)
      : [];
    return text ? { text, alternatives: alternatives.slice(0, 3) } : null;
  } catch {
    const text = content.trim();
    return text ? { text, alternatives: [] } : null;
  }
};

const buildRewriteMessages = (text: string, options: AsrSessionOptions) => [
  {
    role: "system",
    content: [
      "You clean up speech-to-text dictation for a composer input.",
      "Preserve the user's meaning and language.",
      "Fix obvious ASR mistakes, punctuation, spacing, and domain terms.",
      "Do not invent content.",
      'Return compact JSON: {"text":"...","alternatives":["..."]}.',
    ].join(" "),
  },
  {
    role: "user",
    content: JSON.stringify({
      text,
      hotwords: options.hotwords.slice(0, 40),
      contextText: options.contextText?.slice(-600) ?? "",
      contextMessages: options.contextMessages.slice(-4),
    }),
  },
];

export const rewriteAsrText = async (
  text: string,
  options: AsrSessionOptions,
  input: { llm?: boolean } = { llm: true },
): Promise<AsrRewriteResult> => {
  const originalText = postprocessAsrText(text, options);
  if (!originalText || !input.llm || !gatewayConfig.asrRewrite.enabled) {
    return {
      text: originalText,
      originalText,
      alternatives: [],
      rewritten: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    gatewayConfig.asrRewrite.timeoutMs,
  );
  try {
    const response = await fetch(
      `${gatewayConfig.asrRewrite.baseUrl}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${gatewayConfig.asrRewrite.apiKey}`,
        },
        body: JSON.stringify({
          model: gatewayConfig.asrRewrite.model,
          temperature: 0,
          max_tokens: 220,
          messages: buildRewriteMessages(originalText, options),
        }),
      },
    );
    if (!response.ok)
      return {
        text: originalText,
        originalText,
        alternatives: [],
        rewritten: false,
      };
    const parsed = parseRewriteResponse(await response.json());
    if (!parsed)
      return {
        text: originalText,
        originalText,
        alternatives: [],
        rewritten: false,
      };
    const normalized = postprocessAsrText(parsed.text, options);
    if (!normalized)
      return {
        text: originalText,
        originalText,
        alternatives: [],
        rewritten: false,
      };
    const alternatives = [originalText, ...parsed.alternatives]
      .map((item) => postprocessAsrText(item, options))
      .filter(
        (item, index, values) =>
          item && values.indexOf(item) === index && item !== normalized,
      )
      .slice(0, 3);
    return {
      text: normalized,
      originalText,
      alternatives,
      rewritten: normalized !== originalText || alternatives.length > 0,
    };
  } catch {
    return {
      text: originalText,
      originalText,
      alternatives: [],
      rewritten: false,
    };
  } finally {
    clearTimeout(timeout);
  }
};
