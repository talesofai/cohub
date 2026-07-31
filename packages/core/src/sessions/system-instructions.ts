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
  let publicMeta = meta;
  if (
    Object.hasOwn(meta, "systemInstructions")
    || Object.hasOwn(meta, "requestFingerprint")
    || Object.hasOwn(meta, "env")
  ) {
    publicMeta = { ...meta };
  }
  delete publicMeta.systemInstructions;
  delete publicMeta.requestFingerprint;
  delete publicMeta.env;

  if (publicMeta.context && typeof publicMeta.context === "object" && !Array.isArray(publicMeta.context)) {
    const context = publicMeta.context as Record<string, unknown>;
    if (Object.hasOwn(context, "auth") || Object.hasOwn(context, "env")) {
      const publicContext = { ...context };
      delete publicContext.auth;
      delete publicContext.env;
      if (publicMeta === meta) publicMeta = { ...meta };
      if (Object.keys(publicContext).length > 0) publicMeta.context = publicContext;
      else delete publicMeta.context;
    }
  }
  return Object.keys(publicMeta).length > 0 ? publicMeta : null;
}
