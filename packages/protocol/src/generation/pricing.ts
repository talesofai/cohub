export const GENERATION_PRICING_UNITS = ["image", "second", "request", "1m_tokens"] as const;

export type GenerationPricingUnit = (typeof GENERATION_PRICING_UNITS)[number];

/**
 * Display price for a generation model, maintained in the platform config space
 * and synced from the upstream gateway catalog.
 *
 * `unit` names what one charge covers. `amount` is the exact unit price; use
 * `min`/`max` instead when the price depends on request parameters (resolution,
 * duration, quality) and a single number would mislead.
 */
export type GenerationModelPricing = {
  unit: GenerationPricingUnit;
  amount?: number;
  min?: number;
  max?: number;
  /** Short qualifier shown with the price, e.g. "std–pro". */
  note?: string;
};

const UNITS = new Set<string>(GENERATION_PRICING_UNITS);
const PRICING_KEYS = new Set(["unit", "amount", "min", "max", "note"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isGenerationModelPricing(value: unknown): value is GenerationModelPricing {
  if (!isRecord(value)) return false;
  if (!UNITS.has(value.unit as string)) return false;
  if (!Object.keys(value).every((key) => PRICING_KEYS.has(key))) return false;
  if (value.note !== undefined && typeof value.note !== "string") return false;

  const hasAmount = value.amount !== undefined;
  const hasRange = value.min !== undefined || value.max !== undefined;
  if (hasAmount === hasRange) return false;
  if (hasAmount) return isFiniteNonNegative(value.amount);

  if (value.min !== undefined && !isFiniteNonNegative(value.min)) return false;
  if (value.max !== undefined && !isFiniteNonNegative(value.max)) return false;
  if (value.min !== undefined && value.max !== undefined) return value.min <= value.max;
  return true;
}
