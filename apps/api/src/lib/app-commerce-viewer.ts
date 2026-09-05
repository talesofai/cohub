import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";

export type CommerceExecutionContext = {
  source: string;
  appId: string | null;
  viewerUserId: string | null;
} | null;

export function resolveCommerceViewerUserId(
  execution: CommerceExecutionContext,
  appId: string,
  fallbackUserId: string,
): string | null {
  if (execution?.source !== APP_ACTION_EXECUTION_SOURCE) return fallbackUserId;
  return execution.appId === appId ? execution.viewerUserId : null;
}

export function canTargetCommerceViewer(
  execution: CommerceExecutionContext,
  viewerUserId: string,
  targetUserId: string | null,
): boolean {
  if (!targetUserId || targetUserId === viewerUserId) return true;
  return execution?.source !== APP_ACTION_EXECUTION_SOURCE;
}
