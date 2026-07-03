import type { Permission } from "@cohub/core/permissions";

const currentBySessionId = new Map<string, { turnId: string | null; actorUserId: string | null; executionToken: string | null; executionScopes: Permission[] }>();

export function setCurrentSessionExecutionAuth(input: {
  sessionId: string;
  turnId?: string | null;
  actorUserId?: string | null;
  executionToken?: string | null;
  executionScopes?: Permission[] | null;
}) {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return;
  currentBySessionId.set(sessionId, {
    turnId: input.turnId?.trim() || null,
    actorUserId: input.actorUserId?.trim() || null,
    executionToken: input.executionToken?.trim() || null,
    executionScopes: input.executionScopes ?? [],
  });
}

export function getCurrentSessionExecutionAuth(sessionId: string, turnId: string) {
  const auth = currentBySessionId.get(sessionId.trim()) ?? null;
  const normalizedTurnId = turnId.trim();
  if (!auth || !normalizedTurnId || auth.turnId !== normalizedTurnId) return null;
  return auth;
}

export function clearCurrentSessionExecutionAuth(sessionId: string) {
  currentBySessionId.delete(sessionId.trim());
}
