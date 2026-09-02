import type { AppRuntimeInvocationContext } from "@neta-art/cohub";

export type TaskBrowserScope =
  | { kind: "session"; spaceId: string; sessionId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "mine" };

export function taskBrowserScopes(
  invocation: AppRuntimeInvocationContext | null | undefined,
): TaskBrowserScope[] {
  const scopes: TaskBrowserScope[] = [];
  if (invocation?.spaceId && invocation.sessionId) {
    scopes.push({
      kind: "session",
      spaceId: invocation.spaceId,
      sessionId: invocation.sessionId,
    });
  }
  if (invocation?.spaceId) {
    scopes.push({ kind: "space", spaceId: invocation.spaceId });
  }
  scopes.push({ kind: "mine" });
  return scopes;
}
