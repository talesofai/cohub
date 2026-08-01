import { assertLabelPathsAllowed, parseLabelRefs, type LabelPath } from "@cohub/core/labels";
import {
  parsePromptEnv,
  parsePromptSystemInstructions,
  type PromptAccessMode,
} from "@cohub/core/sessions";
import { normalizeGenerationPolicy } from "@cohub/protocol/generation";
import { contentBlockSchema } from "@cohub/protocol/realtime/schema";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_FIELDS = new Set([
  "auth",
  "content",
  "clientMessageId",
  "generationPolicy",
  "intent",
  "accessMode",
  "env",
  "systemInstructions",
  "source",
  "sessionId",
  "title",
  "model",
  "provider",
  "thinkingLevel",
  "labelRefs",
]);

export class ScheduledPromptPayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledPromptPayloadValidationError";
  }
}

function normalizeOptionalString(value: unknown, field: string, maxLength = 255) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ScheduledPromptPayloadValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new ScheduledPromptPayloadValidationError(`${field} must be at most ${maxLength} characters`);
  return normalized;
}

function setOptionalString(payload: Record<string, unknown>, field: string, maxLength = 255) {
  const value = normalizeOptionalString(payload[field], field, maxLength);
  if (value) payload[field] = value;
  else delete payload[field];
}

function parseAccessMode(value: unknown): PromptAccessMode {
  if (value === undefined || value === null || value === "full_access") return "full_access";
  if (value === "read_only") return "read_only";
  throw new ScheduledPromptPayloadValidationError("accessMode must be one of: read_only, full_access");
}

function parseIntent(value: unknown): "followup" | "steer" {
  if (value === undefined || value === null || value === "followup") return "followup";
  if (value === "steer") return "steer";
  throw new ScheduledPromptPayloadValidationError("intent must be one of: followup, steer");
}

export function validateScheduledSendMessagePayload(input: Record<string, unknown>): {
  payload: Record<string, unknown>;
  accessMode: PromptAccessMode;
  labelPaths: LabelPath[];
} {
  try {
    const payload = { ...input };
    const unexpectedField = Object.keys(payload).find((field) => !ALLOWED_FIELDS.has(field));
    if (unexpectedField) {
      throw new ScheduledPromptPayloadValidationError(`payload.${unexpectedField} is not supported`);
    }
    const content = contentBlockSchema.array().min(1).safeParse(payload.content);
    if (!content.success) {
      throw new ScheduledPromptPayloadValidationError("content must be a non-empty ContentBlock array");
    }
    payload.content = content.data;

    const accessMode = parseAccessMode(payload.accessMode);
    if (accessMode === "read_only") payload.accessMode = accessMode;
    else delete payload.accessMode;
    if (accessMode === "read_only" && content.data.some((block) => block.type === "shell_command")) {
      throw new ScheduledPromptPayloadValidationError("shell_command is not allowed in read_only accessMode");
    }

    const intent = parseIntent(payload.intent);
    if (intent === "steer") payload.intent = intent;
    else delete payload.intent;

    if (payload.generationPolicy === undefined || payload.generationPolicy === null) {
      delete payload.generationPolicy;
    } else {
      const generationPolicy = normalizeGenerationPolicy(payload.generationPolicy);
      if (!generationPolicy) throw new ScheduledPromptPayloadValidationError("generationPolicy is invalid");
      payload.generationPolicy = generationPolicy;
    }

    const thinkingLevel = normalizeOptionalString(payload.thinkingLevel, "thinkingLevel");
    if (thinkingLevel && !VALID_THINKING_LEVELS.has(thinkingLevel)) {
      throw new ScheduledPromptPayloadValidationError("thinkingLevel must be one of: off, minimal, low, medium, high, xhigh, max");
    }
    if (thinkingLevel) payload.thinkingLevel = thinkingLevel;
    else delete payload.thinkingLevel;

    const env = parsePromptEnv(payload.env);
    if (env) payload.env = env;
    else delete payload.env;
    const systemInstructions = parsePromptSystemInstructions(payload.systemInstructions);
    if (systemInstructions) payload.systemInstructions = systemInstructions;
    else delete payload.systemInstructions;

    for (const field of ["clientMessageId", "sessionId", "title", "source", "model", "provider"]) {
      setOptionalString(payload, field);
    }

    const labelPaths = parseLabelRefs(payload.labelRefs);
    assertLabelPathsAllowed(labelPaths);
    if (labelPaths.length > 0) payload.labelRefs = labelPaths.map((path) => path.join("/")).sort();
    else delete payload.labelRefs;

    return { payload, accessMode, labelPaths };
  } catch (error) {
    if (error instanceof ScheduledPromptPayloadValidationError) throw error;
    throw new ScheduledPromptPayloadValidationError(error instanceof Error ? error.message : String(error));
  }
}
