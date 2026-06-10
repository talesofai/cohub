import { createHash } from "node:crypto";
import {
  clampAsrEndWindowSizeMs,
  clampAsrForceToSpeechTimeMs,
} from "./limits.js";
import type { AsrSessionOptions } from "./options.js";

export type AsrExperimentVariant = {
  name: string;
  weight: number;
  options: Partial<
    Pick<
      AsrSessionOptions,
      | "endWindowSizeMs"
      | "forceToSpeechTimeMs"
      | "enableNonstream"
      | "enablePunctuation"
      | "enableItn"
      | "enableDdc"
    >
  >;
};

export type AsrExperimentSelection = {
  experiment: string | null;
  variant: string | null;
  options: AsrSessionOptions;
};

const clampWeight = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const normalizeVariant = (value: unknown): AsrExperimentVariant | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const weight = clampWeight(input.weight);
  const rawOptions = input.options;
  if (
    !name ||
    weight <= 0 ||
    !rawOptions ||
    typeof rawOptions !== "object" ||
    Array.isArray(rawOptions)
  )
    return null;
  const options = rawOptions as Record<string, unknown>;
  const output: AsrExperimentVariant["options"] = {};
  const copyNumber = (
    key: "endWindowSizeMs" | "forceToSpeechTimeMs",
    clamp: (value: number) => number,
  ) => {
    const number = Number(options[key]);
    if (Number.isFinite(number)) output[key] = clamp(number);
  };
  const copyBoolean = (
    key: "enableNonstream" | "enablePunctuation" | "enableItn" | "enableDdc",
  ) => {
    if (typeof options[key] === "boolean") output[key] = options[key];
  };
  copyNumber("endWindowSizeMs", clampAsrEndWindowSizeMs);
  copyNumber("forceToSpeechTimeMs", clampAsrForceToSpeechTimeMs);
  copyBoolean("enableNonstream");
  copyBoolean("enablePunctuation");
  copyBoolean("enableItn");
  copyBoolean("enableDdc");
  return { name, weight, options: output };
};

export const parseAsrExperimentVariants = (raw: string | undefined) => {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeVariant)
      .filter((item): item is AsrExperimentVariant => Boolean(item));
  } catch {
    return [];
  }
};

const stableBucket = (input: string) => {
  const hash = createHash("sha256").update(input).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
};

export const selectAsrExperimentVariant = (
  variants: AsrExperimentVariant[],
  seed: string,
): AsrExperimentVariant | null => {
  const totalWeight = variants.reduce(
    (sum, variant) => sum + variant.weight,
    0,
  );
  if (totalWeight <= 0) return null;
  const target = stableBucket(seed) * totalWeight;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weight;
    if (target <= cursor) return variant;
  }
  return variants[variants.length - 1] ?? null;
};

export const applyAsrExperiment = (
  options: AsrSessionOptions,
  input: {
    experimentName: string;
    variants: AsrExperimentVariant[];
    userId: string;
    requestId: string;
  },
): AsrExperimentSelection => {
  const experiment = input.experimentName;
  if (!experiment || input.variants.length === 0)
    return { experiment: null, variant: null, options };
  const selected = selectAsrExperimentVariant(
    input.variants,
    `${experiment}:${input.userId}:${input.requestId}`,
  );
  if (!selected) return { experiment, variant: null, options };
  return {
    experiment,
    variant: selected.name,
    options: {
      ...options,
      ...selected.options,
    },
  };
};
