import type { AsrSessionOptions } from "./options.js";

const ENGLISH_FILLERS = /\b(?:um+|uh+|er+|ah+)\b[,.，。 ]*/gi;
const CHINESE_FILLERS = /(?:^|[，。！？\s])(?:嗯+|呃+|额+|那个)(?=[，。！？\s]|$)/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isAsciiTerm = (value: string) => /^[\x20-\x7e]+$/.test(value);

const normalizeWhitespace = (text: string) => text
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\s+([,.;:!?，。！？；：])/g, "$1")
  .replace(/([（(])\s+/g, "$1")
  .replace(/\s+([）)])/g, "$1")
  .trim();

const cleanupFillers = (text: string) => text
  .replace(ENGLISH_FILLERS, "")
  .replace(CHINESE_FILLERS, (match) => {
    const first = match[0] ?? "";
    return /[，。！？\s]/.test(first) ? first.trimEnd() : "";
  });

const rewritePunctuation = (text: string) => text
  .replace(/([。！？!?])\1+/g, "$1")
  .replace(/([，,])\1+/g, "$1")
  .replace(/ ?([,;:!?]) ?/g, "$1 ")
  .replace(/ ([，。！？；：])/g, "$1")
  .replace(/\s+$/g, "");

const applyContextTerms = (text: string, terms: string[]) => {
  let output = text;
  const sorted = [...terms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 40)
    .sort((a, b) => b.length - a.length);

  for (const term of sorted) {
    if (!isAsciiTerm(term)) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    output = output.replace(pattern, term);
  }
  return output;
};

export const postprocessAsrText = (text: string, options: AsrSessionOptions) => {
  if (!options.postProcessing.enabled) return text;

  let output = text;
  if (options.postProcessing.cleanupFillers) output = cleanupFillers(output);
  if (options.postProcessing.rewritePunctuation) output = rewritePunctuation(output);
  if (options.postProcessing.applyContextTerms) output = applyContextTerms(output, options.hotwords);
  if (options.postProcessing.normalizeWhitespace) output = normalizeWhitespace(output);
  return output;
};
