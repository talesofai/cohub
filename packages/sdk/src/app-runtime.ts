import { buildAppRuntimeReady } from "@cohub/protocol/app-runtime";
import {
  buildAppNavigationOpenMessage,
  type AppNavigationOpenResponse,
  type AppNavigationTarget,
  type AppNavigationCall,
  parseAppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import type { Permission } from "./types.js";

export type AppRuntimeInvocationContext = {
  surface: "page" | "app" | "background" | "broker";
  source?: "desktop_command" | "user" | "route";
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
};

export type AppRuntimeGrantSummary = {
  spaceId: string;
  scopes: Permission[];
};

export type AppRuntimeContext = {
  app: {
    id: string;
    slug: string;
    url?: string | null;
    /** The Space that owns the App. */
    homeSpace?: { id: string; name?: string | null };
  };
  /** @deprecated Use `app.homeSpace` for the App's home Space. */
  space: { id: string; name?: string | null };
  viewer?: { userUuid: string } | null;
  invocation?: AppRuntimeInvocationContext;
  permissions?: {
    scopes: Permission[];
    appScopes: Permission[];
    viewerScopes: Permission[];
    /** Per-space viewer-consented grants. */
    viewerGrants?: AppRuntimeGrantSummary[];
  };
};

export type AppRuntimeCheckoutStatus = "success" | "failed" | "cancel" | null;

export type AppRuntimeCheckoutState = {
  status: AppRuntimeCheckoutStatus;
  orderId: string | null;
};

type RuntimeResponse =
  | { type: "cohub.app.context.result"; requestId: string; context: AppRuntimeContext }
  | { type: "cohub.app.token.result"; requestId: string; token: string | null }
  | { type: "cohub.app.authorize.result"; requestId: string; token: string | null }
  | { type: "cohub.app.purchase.result"; requestId: string; checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }
  | { type: "cohub.app.checkout-state.result"; requestId: string; status: AppRuntimeCheckoutStatus; orderId: string | null }
  | { type: "cohub.app.error"; requestId: string; message: string };

/**
 * Options for a single app runtime transport request.
 */
export type AppRuntimeRequestOptions = {
  /** How long to wait for a matching response before resolving with null. */
  timeoutMs?: number;
  /** When set, re-posts the request on this interval until a response arrives. */
  retryIntervalMs?: number;
};

/**
 * Transport layer for {@link AppRuntimeApi}. Decoupled so the same API can run
 * over either the iframe parent bridge (bridge mode) or a popup broker window
 * (broker mode). The transport is responsible for posting the request and
 * resolving with the first matching response (or null on timeout).
 */
export type AppContextChangedListener = (context: AppRuntimeContext) => void;

export interface AppRuntimeTransport {
  request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null>;
  subscribeContextChanged?: (listener: AppContextChangedListener) => () => void;
  /** Whether this transport can address the embedding Cohub workspace. */
  supportsNavigation?: boolean;
}

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

const generateRequestId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Bridge-mode transport: posts messages to `window.parent` (the Cohub host
 * embedding the app in an iframe) and listens for the matching reply.
 * Behaviorally identical to the previous module-level `request()` helper.
 */
export class ParentBridgeTransport implements AppRuntimeTransport {
  readonly supportsNavigation = true;
  private trustedParentOrigin: string | null = null;
  private contextListeners = new Set<AppContextChangedListener>();
  private contextListener: ((event: MessageEvent) => void) | null = null;

  subscribeContextChanged(listener: AppContextChangedListener) {
    if (!hasParent()) return () => {};
    this.contextListeners.add(listener);
    if (!this.contextListener) {
      this.contextListener = (event) => {
        if (event.source !== window.parent) return;
        const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
        if (parentOrigin && event.origin !== parentOrigin) return;
        const data = event.data as { type?: string; context?: AppRuntimeContext };
        if (data?.type !== "cohub.app.context.changed" || !data.context) return;
        for (const current of this.contextListeners) current(data.context);
      };
      window.addEventListener("message", this.contextListener);
      const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
      if (parentOrigin) {
        try {
          window.parent.postMessage(buildAppRuntimeReady(), parentOrigin);
        } catch {
          // The host may have been disposed during app startup.
        }
      }
    }
    return () => {
      this.contextListeners.delete(listener);
      if (this.contextListeners.size === 0 && this.contextListener) {
        window.removeEventListener("message", this.contextListener);
        this.contextListener = null;
      }
    };
  }

  request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null> {
    const timeoutMs = options?.timeoutMs ?? 1_200;
    const retryIntervalMs = options?.retryIntervalMs;
    if (!hasParent()) return Promise.resolve(null);
    const requestId =
      typeof message.requestId === "string" && message.requestId
        ? message.requestId
        : generateRequestId();
    return new Promise((resolve, reject) => {
      let retryTimer: ReturnType<typeof setInterval> | null = null;
      const parentOrigin = this.trustedParentOrigin ?? getParentOrigin();
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
        this.trustedParentOrigin = event.origin;
        if (data.type === "cohub.app.error") {
          reject(new Error(data.message));
          return;
        }
        resolve(data as T);
      };
      window.addEventListener("message", onMessage);
      postRequest();
      if (retryIntervalMs) retryTimer = setInterval(postRequest, retryIntervalMs);
    });
  }
}

/**
 * Broker-mode transport for standalone-deployed apps. Opens a popup window to
 * the Cohub auth broker page, performs a ready-handshake, sends the request via
 * postMessage, and resolves with the broker's response. The popup is closed
 * after a single request is fulfilled (one-shot, per §7.2 of the plan).
 *
 * Non-interactive messages (`context`, `checkout-state`) are answered locally
 * without opening a popup — the app already knows its own appId, and
 * checkout state is not available on the app's own origin in broker mode.
 */
export class PopupBrokerTransport implements AppRuntimeTransport {
  readonly supportsNavigation = false;
  private readonly brokerOrigin: string;
  private readonly appId?: string;
  private readonly getAppId?: () => Promise<string | null>;

  constructor(config: {
    brokerOrigin: string;
    /** Explicit app id. When absent, {@link getAppId} is used to resolve it. */
    appId?: string;
    /**
     * Lazily resolves the app id at runtime (e.g. via the public
     * `apps.getBySlug` reverse lookup). Used in standalone deployments where
     * the appId is not known at code-authoring time. The resolver is expected
     * to cache its own result.
     */
    getAppId?: () => Promise<string | null>;
  }) {
    this.brokerOrigin = config.brokerOrigin;
    this.appId = config.appId;
    this.getAppId = config.getAppId;
    // Warm the appId cache eagerly so that a click-triggered popup does not
    // have to await a network round-trip (which would break the browser's
    // transient user-activation and get the popup blocked).
    if (!this.appId && this.getAppId) void this.getAppId();
  }

  private resolveAppId(): Promise<string | null> {
    if (this.appId) return Promise.resolve(this.appId);
    if (this.getAppId) return this.getAppId();
    return Promise.resolve(null);
  }

  async request<T>(
    message: Record<string, unknown>,
    options?: AppRuntimeRequestOptions,
  ): Promise<T | null> {
    // Non-interactive messages are answered locally to avoid popping up a
    // window for data the app already has (or cannot have).
    if (message.type === "cohub.app.context") {
      const appId = await this.resolveAppId();
      return {
        type: "cohub.app.context.result",
        context: {
          app: { id: appId ?? "", slug: "", url: null },
          space: { id: "" },
          permissions: { scopes: [], appScopes: [], viewerScopes: [] },
        },
      } as T;
    }
    if (message.type === "cohub.app.checkout-state") {
      return {
        type: "cohub.app.checkout-state.result",
        status: null,
        orderId: null,
      } as T;
    }

    const timeoutMs = options?.timeoutMs ?? 120_000;
    const requestId = generateRequestId();

    // Resolve the appId before opening the popup. When warmed at construction
    // this is an already-settled promise, so the await is a microtask and the
    // popup still opens within the user-activation window.
    const appId = await this.resolveAppId();
    if (!appId) {
      throw new Error(
        "Unable to resolve the app id for broker mode. Provide `appId` or a valid slug triple (ownerUsername, spaceSlug, appSlug).",
      );
    }

    return new Promise<T | null>((resolve, reject) => {
      if (typeof window === "undefined" || typeof window.open !== "function") {
        resolve(null);
        return;
      }

      const appOrigin = window.location.origin;
      const brokerUrl = `${this.brokerOrigin}/app-auth?app=${encodeURIComponent(appId)}&origin=${encodeURIComponent(appOrigin)}`;

      const popup = window.open(brokerUrl, "cohub-app-auth", "popup,width=480,height=640");
      if (!popup) {
        reject(new Error("Failed to open authorization window. Please allow popups for this site."));
        return;
      }

      let ready = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closeChecker: ReturnType<typeof setInterval> | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (closeChecker) clearInterval(closeChecker);
        window.removeEventListener("message", onMessage);
        try { popup.close(); } catch { /* ignore */ }
        fn();
      };

      timer = setTimeout(() => {
        finish(() => {
          if (!ready) reject(new Error("Authorization window did not respond in time."));
          else resolve(null);
        });
      }, timeoutMs);

      const onMessage = (event: MessageEvent<RuntimeResponse | { type: string; requestId?: string }>) => {
        if (event.source !== popup) return;
        if (event.origin !== this.brokerOrigin) return;
        const data = event.data;
        if (!data) return;

        // Handshake: broker signals it's ready to receive the actual request.
        if (data.type === "cohub.app.broker.ready" && !ready) {
          ready = true;
          try {
            popup.postMessage({ ...message, requestId }, this.brokerOrigin);
          } catch {
            finish(() => reject(new Error("Failed to send request to authorization window.")));
          }
          return;
        }

        // Response to our request.
        if (data.requestId !== requestId) return;
        finish(() => {
          if (data.type === "cohub.app.error") {
            reject(new Error((data as { message: string }).message));
            return;
          }
          resolve(data as T);
        });
      };

      window.addEventListener("message", onMessage);

      // Safety: if the popup closes before responding, reject.
      closeChecker = setInterval(() => {
        if (popup.closed) {
          finish(() => {
            if (!ready) reject(new Error("Authorization window was closed."));
            else resolve(null);
          });
        }
      }, 500);
    });
  }
}

const TOKEN_STORAGE_PREFIX = "cohub:app-token";

const AUTHORIZED_GRANTS_STORAGE_PREFIX = "cohub:app-auth-grants";

/** Outcome of {@link AppRuntimeApi.requestSpaceAuthorization}. */
export type AppRuntimeAuthorizationResult = {
  granted: boolean;
  space: { id: string; name: string | null } | null;
};

/** A consent remembered client-side so token refreshes can re-authorize. */
export type AppRuntimeAuthorizedGrant = {
  /** Target space; omitted for the app's home space. */
  spaceId?: string;
  scopes: Permission[];
};

/** The space a server response actually granted, when it says so. */
const responseSpaceId = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * Records one consent, keyed by its space. Newer entries replace older ones
 * for the same space, so implicit home-space requests (no `spaceId`) and
 * explicit ones converge onto a single entry once the server echoes its
 * canonical space id back.
 */
function recordConsent(
  grants: AppRuntimeAuthorizedGrant[] | null | undefined,
  spaceId: string | undefined,
  scopes: Permission[],
): AppRuntimeAuthorizedGrant[] {
  const others = (grants ?? []).filter((grant) => grant.spaceId !== spaceId);
  return [...others, spaceId ? { spaceId, scopes } : { scopes }];
}

const isAuthorizedGrant = (value: unknown): value is AppRuntimeAuthorizedGrant => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AppRuntimeAuthorizedGrant>;
  return (
    (record.spaceId === undefined || typeof record.spaceId === "string") &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string")
  );
};

export class AppRuntimeApi {
  private token: string | null = null;
  private readonly transport: AppRuntimeTransport;
  private tokenStorageKey: string | null;
  private grantsStorageKey: string | null;
  private readonly appIdResolver?: AppIdResolver;
  /** Ensures storage keys are resolved (via slug lookup) at most once. */
  private storageKeysReady: Promise<void> | null;
  /** Consents previously granted via requestAuthorization, retained so token
   * refreshes can re-authorize (preserving viewer grants) instead of falling
   * back to a base session token that only carries app-side scopes. */
  private authorizedGrants: AppRuntimeAuthorizedGrant[] | null = null;

  constructor(
    transport: AppRuntimeTransport = new ParentBridgeTransport(),
    appId?: string,
    appIdResolver?: AppIdResolver,
  ) {
    this.transport = transport;
    this.appIdResolver = appIdResolver;
    if (appId) {
      // appId known up-front — keys are immediately available.
      this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${appId}`;
      this.grantsStorageKey = `${AUTHORIZED_GRANTS_STORAGE_PREFIX}:${appId}`;
      this.storageKeysReady = Promise.resolve();
      // Restore a cached token from localStorage (broker-mode UX optimization;
      // see §0 — this is not a security measure).
      this.token = this.readStoredToken();
      this.authorizedGrants = this.readStoredGrants();
    } else if (appIdResolver) {
      // appId resolved lazily via slug reverse lookup. Storage keys — and any
      // cached token — become available only after the lookup completes.
      this.tokenStorageKey = null;
      this.grantsStorageKey = null;
      this.storageKeysReady = null;
    } else {
      this.tokenStorageKey = null;
      this.grantsStorageKey = null;
      this.storageKeysReady = Promise.resolve();
    }
  }

  /**
   * Resolves the localStorage keys once the appId is known. When the appId is
   * only available via slug reverse lookup, this performs the lookup on first
   * use and then restores any cached token/scopes for that appId.
   */
  private ensureStorageKeys(): Promise<void> {
    if (this.storageKeysReady) return this.storageKeysReady;
    this.storageKeysReady = (async () => {
      const appId = this.appIdResolver ? await this.appIdResolver() : null;
      if (appId) {
        this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${appId}`;
        this.grantsStorageKey = `${AUTHORIZED_GRANTS_STORAGE_PREFIX}:${appId}`;
        // Now that keys are known, hydrate from localStorage.
        const stored = this.readStoredToken();
        if (stored && !this.token) this.token = stored;
        const storedGrants = this.readStoredGrants();
        if (storedGrants && !this.authorizedGrants) this.authorizedGrants = storedGrants;
      }
    })();
    return this.storageKeysReady;
  }

  private readStoredToken(): string | null {
    if (!this.tokenStorageKey || typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(this.tokenStorageKey);
    } catch {
      return null;
    }
  }

  private writeStoredToken(token: string | null) {
    if (!this.tokenStorageKey || typeof localStorage === "undefined") return;
    try {
      if (token) localStorage.setItem(this.tokenStorageKey, token);
      else localStorage.removeItem(this.tokenStorageKey);
    } catch {
      // ignore storage failures (quota, privacy mode)
    }
  }

  private readStoredGrants(): AppRuntimeAuthorizedGrant[] | null {
    if (!this.grantsStorageKey || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.grantsStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(isAuthorizedGrant)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeStoredGrants(grants: AppRuntimeAuthorizedGrant[] | null) {
    if (!this.grantsStorageKey || typeof localStorage === "undefined") return;
    try {
      if (grants && grants.length > 0) localStorage.setItem(this.grantsStorageKey, JSON.stringify(grants));
      else localStorage.removeItem(this.grantsStorageKey);
    } catch {
      // ignore storage failures
    }
  }

  async context() {
    const response = await this.transport.request<{ context: AppRuntimeContext }>(
      { type: "cohub.app.context" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    return response?.context ?? null;
  }

  onContextChanged(listener: AppContextChangedListener) {
    return this.transport.subscribeContextChanged?.(listener) ?? (() => {});
  }

  async navigationOpen(
    target: AppNavigationTarget,
    call?: AppNavigationCall,
  ): Promise<AppNavigationOpenResponse> {
    if (this.transport.supportsNavigation === false) {
      return {
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId: "local",
        handled: false,
        reason: "unsupported",
      };
    }
    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const response = await this.transport.request<unknown>(
      buildAppNavigationOpenMessage({
        requestId,
        target,
        ...(call ? { call } : {}),
      }),
      { timeoutMs: 8_000 },
    );
    const parsed = parseAppNavigationOpenResponse(response);
    return (
      (parsed && parsed.requestId === requestId ? parsed : null) ?? {
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId,
        handled: false,
        reason: response === null ? "timeout" : "unsupported",
      }
    );
  }

  async getAccessToken(options?: { forceRefresh?: boolean }) {
    await this.ensureStorageKeys();
    if (this.token && !options?.forceRefresh) return this.token;
    if (options?.forceRefresh) {
      this.token = null;
      this.writeStoredToken(null);
    }
    // When refreshing a token, re-authorize every consent the app previously
    // obtained so the refreshed token retains those viewer grants. A plain
    // /session token only carries app-side scopes, which would cause 403 on
    // viewer-scoped operations. Each authorize call returns a token carrying
    // all live grants, so the last response is the complete token.
    if (options?.forceRefresh && this.authorizedGrants && this.authorizedGrants.length > 0) {
      // A denied consent (the viewer denied the dialog, or the server
      // rejected the renewal) is dropped; a transient failure (network,
      // unavailable host) keeps the consent so a later refresh can renew it.
      let refreshed = false;
      let next: AppRuntimeAuthorizedGrant[] = [];
      for (const grant of this.authorizedGrants) {
        try {
          const response = await this.transport.request<{ token: string | null; space?: { id?: unknown } | null }>(
            { type: "cohub.app.authorize", scopes: grant.scopes, spaceId: grant.spaceId },
            { timeoutMs: 120_000 },
          );
          const token = response?.token ?? null;
          if (!token) continue; // denied — drop this consent, keep the others
          this.token = token;
          next = recordConsent(next, responseSpaceId(response?.space?.id) ?? grant.spaceId, grant.scopes);
          refreshed = true;
        } catch {
          // Transient failure — keep the consent untouched.
          next = recordConsent(next, grant.spaceId, grant.scopes);
        }
      }
      this.authorizedGrants = next;
      this.writeStoredGrants(next);
      if (refreshed) {
        this.writeStoredToken(this.token);
        return this.token;
      }
      // Nothing refreshed — fall through to a plain session token. Viewer
      // grants still apply server-side, so the app keeps working.
    }
    const response = await this.transport.request<{ token: string | null }>(
      { type: "cohub.app.token", forceRefresh: Boolean(options?.forceRefresh) },
      { timeoutMs: 20_000 },
    );
    this.token = response?.token ?? null;
    this.writeStoredToken(this.token);
    return this.token;
  }

  /**
   * Requests viewer consent. Without a `spaceId` the grant targets the app's
   * home space; with one it targets that space — the app may only grant what
   * the viewer can already do there themselves. Reuses a previous grant
   * silently unless `alwaysAsk` forces the consent dialog.
   */
  async requestAuthorization(input: { scopes: Permission[]; reason?: string; spaceId?: string; alwaysAsk?: boolean }) {
    await this.ensureStorageKeys();
    const response = await this.transport.request<{ token: string | null; space?: { id?: unknown } | null }>(
      { type: "cohub.app.authorize", scopes: input.scopes, reason: input.reason, spaceId: input.spaceId, alwaysAsk: input.alwaysAsk },
      { timeoutMs: 120_000 },
    );
    const token = response?.token ?? null;
    // A denial leaves any existing token untouched — it stays valid until it
    // expires, and only a successful consent replaces it.
    if (token) {
      this.token = token;
      this.writeStoredToken(token);
      const spaceId = responseSpaceId(response?.space?.id) ?? input.spaceId;
      this.authorizedGrants = recordConsent(this.authorizedGrants, spaceId, input.scopes);
      this.writeStoredGrants(this.authorizedGrants);
    }
    return Boolean(token);
  }

  /**
   * Asks the viewer to pick a Space and grant the scopes on it — one consent
   * dialog covers both. Resolves with the picked space so the app knows where
   * it may act; `space` is null when the viewer denied.
   */
  async requestSpaceAuthorization(input: { scopes: Permission[]; reason?: string; alwaysAsk?: boolean }): Promise<AppRuntimeAuthorizationResult> {
    await this.ensureStorageKeys();
    const response = await this.transport.request<{ token: string | null; space?: { id?: unknown; name?: unknown } | null }>(
      { type: "cohub.app.authorize", scopes: input.scopes, reason: input.reason, selectSpace: true, alwaysAsk: input.alwaysAsk },
      { timeoutMs: 120_000 },
    );
    const token = response?.token ?? null;
    const spaceId = typeof response?.space?.id === "string" ? response.space.id : null;
    const spaceName = typeof response?.space?.name === "string" ? response.space.name : null;
    // A denial leaves any existing token untouched.
    if (token) {
      this.token = token;
      this.writeStoredToken(token);
    }
    if (token && spaceId) {
      this.authorizedGrants = recordConsent(this.authorizedGrants, spaceId, input.scopes);
      this.writeStoredGrants(this.authorizedGrants);
    }
    return {
      granted: Boolean(token),
      space: spaceId ? { id: spaceId, name: spaceName } : null,
    };
  }

  async purchase(input: { productKey: string; purchaseAttemptId?: string }) {
    const purchaseAttemptId = input.purchaseAttemptId?.trim() || generateRequestId();
    const response = await this.transport.request<{ checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }>(
      {
        type: "cohub.app.purchase",
        productKey: input.productKey,
        purchaseAttemptId,
      },
      { timeoutMs: 120_000 },
    );
    return response?.checkout ?? null;
  }

  async checkoutState() {
    const response = await this.transport.request<AppRuntimeCheckoutState>(
      { type: "cohub.app.checkout-state" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    return response ?? null;
  }
}

/**
 * Configuration for the app runtime mode.
 */
export type AppRuntimeModeConfig = {
  /** Explicit mode selection. When omitted, auto-detection is used. */
  mode?: "bridge" | "broker";
  /** Cohub origin for the broker page (e.g. "https://cohub.live"). */
  brokerOrigin?: string;
  /**
   * The app's public id. Required for broker mode unless the slug triple
   * below is supplied, in which case the id is resolved at runtime.
   */
  appId?: string;
  /** Space owner's username. Used with {@link spaceSlug} + {@link appSlug} to
   * resolve the appId at runtime via the public `apps.getBySlug` API. */
  ownerUsername?: string;
  /** Space slug. Part of the slug triple used for runtime appId resolution. */
  spaceSlug?: string;
  /** App slug. Part of the slug triple used for runtime appId resolution. */
  appSlug?: string;
};

/** Lazily resolves an app's public id, e.g. via slug reverse lookup. */
export type AppIdResolver = () => Promise<string | null>;

/**
 * Builds a memoized appId resolver that reverse-looks-up the appId from the
 * public slug triple via `GET /api/apps/by-slug/:username/:spaceSlug/:appSlug`
 * (the works REST routes are dual-mounted; `/api/works` keeps serving older
 * consumers with identical payloads). The endpoint is
 * anonymous (no auth) for public apps, so no token is needed. The result is
 * cached; a failed lookup is not cached so it can be retried.
 */
export function createSlugAppIdResolver(deps: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  ownerUsername: string;
  spaceSlug: string;
  appSlug: string;
}): AppIdResolver {
  let cached: Promise<string | null> | null = null;
  return () => {
    if (cached) return cached;
    const run = (async (): Promise<string | null> => {
      const doFetch = deps.fetch ?? globalThis.fetch;
      if (typeof doFetch !== "function") return null;
      const url = `${deps.apiBaseUrl}/api/apps/by-slug/${encodeURIComponent(deps.ownerUsername)}/${encodeURIComponent(deps.spaceSlug)}/${encodeURIComponent(deps.appSlug)}`;
      const response = await doFetch(url);
      if (!response.ok) throw new Error(`getBySlug failed: ${response.status}`);
      const data = (await response.json()) as { work?: { id?: string } } | null;
      return data?.work?.id ?? null;
    })().catch(() => {
      // Do not cache failures — allow a later retry.
      cached = null;
      return null;
    });
    cached = run;
    return run;
  };
}

/**
 * Resolves the appropriate transport based on the app mode configuration.
 * Auto-detection: inside an iframe → bridge; standalone with broker config →
 * broker; otherwise → bridge (returns null for non-app contexts).
 */
export function resolveAppTransport(
  config?: AppRuntimeModeConfig,
  appIdResolver?: AppIdResolver,
): AppRuntimeTransport {
  const explicitMode = config?.mode;
  const brokerOrigin = config?.brokerOrigin;
  const appId = config?.appId;
  const canResolveAppId = Boolean(appId || appIdResolver);
  const hasBrokerConfig = Boolean(brokerOrigin && canResolveAppId);

  const createBroker = (): AppRuntimeTransport =>
    brokerOrigin && canResolveAppId
      ? new PopupBrokerTransport({ brokerOrigin, appId, getAppId: appIdResolver })
      : new ParentBridgeTransport();

  if (explicitMode === "bridge") return new ParentBridgeTransport();
  if (explicitMode === "broker") return createBroker();

  // Auto-detect
  if (typeof window !== "undefined" && window.parent !== window) {
    // Inside an iframe → bridge mode
    return new ParentBridgeTransport();
  }
  // Standalone: use broker if configured, otherwise fall back to bridge
  // (which returns null when there is no parent — the SDK simply isn't in an
  // app runtime context).
  return hasBrokerConfig ? createBroker() : new ParentBridgeTransport();
}

export const createAppRuntime = (
  transport?: AppRuntimeTransport,
  appId?: string,
  appIdResolver?: AppIdResolver,
) => new AppRuntimeApi(transport, appId, appIdResolver);
