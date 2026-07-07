import type { Permission } from "./types.js";

export type WorkRuntimeContext = {
  work: { id: string; slug: string; url?: string | null };
  space: { id: string; name?: string | null };
  viewer?: { userUuid: string } | null;
  permissions?: { scopes: Permission[]; workScopes: Permission[]; viewerScopes: Permission[] };
};

export type WorkRuntimeCheckoutStatus = "success" | "failed" | "cancel" | null;

export type WorkRuntimeCheckoutState = {
  status: WorkRuntimeCheckoutStatus;
  orderId: string | null;
};

type RuntimeResponse =
  | { type: "cohub.work.context.result"; requestId: string; context: WorkRuntimeContext }
  | { type: "cohub.work.token.result"; requestId: string; token: string | null }
  | { type: "cohub.work.authorize.result"; requestId: string; token: string | null }
  | { type: "cohub.work.purchase.result"; requestId: string; checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutClientSecret: string | null; checkoutUiMode: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }
  | { type: "cohub.work.checkout-state.result"; requestId: string; status: WorkRuntimeCheckoutStatus; orderId: string | null }
  | { type: "cohub.work.error"; requestId: string; message: string };

const isBrowser = () => typeof window !== "undefined" && typeof window.parent !== "undefined";
const hasParent = () => isBrowser() && window.parent !== window;
const getParentOrigin = () => {
  if (!isBrowser()) return null;
  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  if (typeof ancestorOrigin === "string" && ancestorOrigin) return ancestorOrigin;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
};
let trustedParentOrigin: string | null = null;

const request = <T>(message: Record<string, unknown>, timeoutMs = 1_200, retryIntervalMs?: number): Promise<T | null> => {
  if (!hasParent()) return Promise.resolve(null);
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    const parentOrigin = trustedParentOrigin ?? getParentOrigin();
    const postRequest = () => {
      try {
        window.parent.postMessage({ ...message, requestId }, parentOrigin ?? "*");
      } catch {
        return;
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (retryTimer) clearInterval(retryTimer);
      window.removeEventListener("message", onMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMessage = (event: MessageEvent<RuntimeResponse>) => {
      if (event.source !== window.parent) return;
      if (parentOrigin && event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || data.requestId !== requestId) return;
      cleanup();
      trustedParentOrigin = event.origin;
      if (data.type === "cohub.work.error") {
        reject(new Error(data.message));
        return;
      }
      resolve(data as T);
    };
    window.addEventListener("message", onMessage);
    postRequest();
    if (retryIntervalMs) retryTimer = setInterval(postRequest, retryIntervalMs);
  });
};

export class WorkRuntimeApi {
  private token: string | null = null;

  async context() {
    const response = await request<{ context: WorkRuntimeContext }>({ type: "cohub.work.context" }, 8_000, 250);
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

  async purchase(input: { productKey: string }) {
    const response = await request<{ checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutClientSecret: string | null; checkoutUiMode: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }>(
      { type: "cohub.work.purchase", productKey: input.productKey },
      900_000,
    );
    return response?.checkout ?? null;
  }

  async checkoutState() {
    const response = await request<WorkRuntimeCheckoutState>({ type: "cohub.work.checkout-state" }, 8_000, 250);
    return response ?? null;
  }
}

export const createWorkRuntime = () => new WorkRuntimeApi();
