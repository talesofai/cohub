import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";

export class PromptSystemInstructionsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptSystemInstructionsValidationError";
  }
}

export function parsePromptSystemInstructions(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw new PromptSystemInstructionsValidationError("systemInstructions must be a string");
  }

  const value = input.trim();
  if (!value) return null;
  if (value.length > MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH) {
    throw new PromptSystemInstructionsValidationError(
      `systemInstructions cannot exceed ${MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH} characters`,
    );
  }
  return value;
}

export function sanitizePromptMetaForClient(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const meta = value as Record<string, unknown>;
  if (!Object.hasOwn(meta, "systemInstructions") && !Object.hasOwn(meta, "requestFingerprint")) return meta;

  const publicMeta = { ...meta };
  delete publicMeta.systemInstructions;
  delete publicMeta.requestFingerprint;
  return Object.keys(publicMeta).length > 0 ? publicMeta : null;
}
