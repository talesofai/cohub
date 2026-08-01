import type { PromptAuthContext } from "@cohub/core/sessions";

export const SCHEDULED_PROMPT_AUTH_MARGIN_MS = 30_000;

export function scheduledPromptAuthCoversExecution(
  auth: PromptAuthContext | null,
  scheduledAt: Date,
): boolean {
  if (!auth) return true;
  return auth.exp * 1000 > scheduledAt.getTime() + SCHEDULED_PROMPT_AUTH_MARGIN_MS;
}
