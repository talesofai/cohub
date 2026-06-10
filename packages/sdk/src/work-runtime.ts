import type { Permission } from "./types.js";

export type WorkRuntimeContext = {
  work: { id: string; slug: string; url?: string | null };
  space: { id: string; name?: string | null };
  viewer?: { userUuid: string } | null;
  permissions?: { scopes: Permission[]; workScopes: Permission[]; viewerScopes: Permission[] };
};

type RuntimeResponse =
  | { type: "cohub.work.context.result"; requestId: string; context: WorkRuntimeContext }
  | { type: "cohub.work.token.result"; requestId: string; token: string | null }
  | { type: "cohub.work.authorize.result"; requestId: string; token: string | null }
  | { type: "cohub.work.error"; requestId: string; message: string };

const isBrowser = () => typeof window !== "undefined" && typeof window.parent !== "undefined";
const hasParent = () => isBrowser() && window.parent !== window;
const getParentOrigin = () => {
  if (!isBrowser()) return null;
  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  if (ancestorOrigin) return ancestorOrigin;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
};
let trustedParentOrigin: string | null = null;

const request = <T>(message: Record<string, unknown>, timeoutMs = 1_200): Promise<T | null> => {
  if (!hasParent()) return Promise.resolve(null);
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
    const parentOrigin = trustedParentOrigin ?? getParentOrigin();
    const onMessage = (event: MessageEvent<RuntimeResponse>) => {
      if (event.source !== window.parent) return;
      if (parentOrigin && event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      trustedParentOrigin = event.origin;
      if (data.type === "cohub.work.error") {
        reject(new Error(data.message));
        return;
      }
      resolve(data as T);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ ...message, requestId }, parentOrigin ?? "*");
  });
};

export class WorkRuntimeApi {
  private token: string | null = null;

  async context() {
    const response = await request<{ context: WorkRuntimeContext }>({ type: "cohub.work.context" }, 8_000);
    return response?.context ?? null;
  }

  async getAccessToken(options?: { forceRefresh?: boolean }) {
    if (this.token && !options?.forceRefresh) return this.token;
    const response = await request<{ token: string | null }>({ type: "cohub.work.token", forceRefresh: Boolean(options?.forceRefresh) }, 20_000);
    this.token = response?.token ?? null;
    return this.token;
  }

  async requestAuthorization(input: { scopes: Permission[]; reason?: string }) {
    const response = await request<{ token: string | null }>({ type: "cohub.work.authorize", scopes: input.scopes, reason: input.reason }, 120_000);
    this.token = response?.token ?? null;
    return Boolean(this.token);
  }
}

export const createWorkRuntime = () => new WorkRuntimeApi();
