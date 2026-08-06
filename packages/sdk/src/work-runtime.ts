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

export type WorkRuntimeNetaCharacter = {
  uuid: string;
  name: string;
  shortName: string;
  type: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  description: string | null;
  isFavored: boolean;
};

export type WorkRuntimeNetaCharacterPage = {
  list: WorkRuntimeNetaCharacter[];
  total: number;
  pageIndex: number;
  pageSize: number;
  hasNext: boolean;
};

type RuntimeResponse =
  | { type: "cohub.work.context.result"; requestId: string; context: WorkRuntimeContext }
  | { type: "cohub.work.token.result"; requestId: string; token: string | null }
  | { type: "cohub.work.authorize.result"; requestId: string; token: string | null }
  | { type: "cohub.work.purchase.result"; requestId: string; checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }
  | { type: "cohub.work.checkout-state.result"; requestId: string; status: WorkRuntimeCheckoutStatus; orderId: string | null }
  | { type: "cohub.neta.characters.result"; requestId: string; page?: WorkRuntimeNetaCharacterPage; ok?: boolean }
  | { type: "cohub.work.error"; requestId: string; message: string };

/**
 * Options for a single work runtime transport request.
 */
export type WorkRuntimeRequestOptions = {
  /** How long to wait for a matching response before resolving with null. */
  timeoutMs?: number;
  /** When set, re-posts the request on this interval until a response arrives. */
  retryIntervalMs?: number;
};

/**
 * Transport layer for {@link WorkRuntimeApi}. Decoupled so the same API can run
 * over either the iframe parent bridge (bridge mode) or a popup broker window
 * (broker mode). The transport is responsible for posting the request and
 * resolving with the first matching response (or null on timeout).
 */
export interface WorkRuntimeTransport {
  request<T>(
    message: Record<string, unknown>,
    options?: WorkRuntimeRequestOptions,
  ): Promise<T | null>;
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
 * embedding the work in an iframe) and listens for the matching reply.
 * Behaviorally identical to the previous module-level `request()` helper.
 */
export class ParentBridgeTransport implements WorkRuntimeTransport {
  private trustedParentOrigin: string | null = null;

  request<T>(
    message: Record<string, unknown>,
    options?: WorkRuntimeRequestOptions,
  ): Promise<T | null> {
    const timeoutMs = options?.timeoutMs ?? 1_200;
    const retryIntervalMs = options?.retryIntervalMs;
    if (!hasParent()) return Promise.resolve(null);
    const requestId = generateRequestId();
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
  }
}

/**
 * Broker-mode transport for standalone-deployed works. Opens a popup window to
 * the Cohub auth broker page, performs a ready-handshake, sends the request via
 * postMessage, and resolves with the broker's response. The popup is closed
 * after a single request is fulfilled (one-shot, per §7.2 of the plan).
 *
 * Non-interactive messages (`context`, `checkout-state`) are answered locally
 * without opening a popup — the work already knows its own workId, and
 * checkout state is not available on the work's own origin in broker mode.
 */
export class PopupBrokerTransport implements WorkRuntimeTransport {
  private readonly brokerOrigin: string;
  private readonly workId?: string;
  private readonly getWorkId?: () => Promise<string | null>;

  constructor(config: {
    brokerOrigin: string;
    /** Explicit work id. When absent, {@link getWorkId} is used to resolve it. */
    workId?: string;
    /**
     * Lazily resolves the work id at runtime (e.g. via the public
     * `works.getBySlug` reverse lookup). Used in standalone deployments where
     * the workId is not known at code-authoring time. The resolver is expected
     * to cache its own result.
     */
    getWorkId?: () => Promise<string | null>;
  }) {
    this.brokerOrigin = config.brokerOrigin;
    this.workId = config.workId;
    this.getWorkId = config.getWorkId;
    // Warm the workId cache eagerly so that a click-triggered popup does not
    // have to await a network round-trip (which would break the browser's
    // transient user-activation and get the popup blocked).
    if (!this.workId && this.getWorkId) void this.getWorkId();
  }

  private resolveWorkId(): Promise<string | null> {
    if (this.workId) return Promise.resolve(this.workId);
    if (this.getWorkId) return this.getWorkId();
    return Promise.resolve(null);
  }

  async request<T>(
    message: Record<string, unknown>,
    options?: WorkRuntimeRequestOptions,
  ): Promise<T | null> {
    // Non-interactive messages are answered locally to avoid popping up a
    // window for data the work already has (or cannot have).
    if (message.type === "cohub.work.context") {
      const workId = await this.resolveWorkId();
      return {
        type: "cohub.work.context.result",
        context: {
          work: { id: workId ?? "", slug: "", url: null },
          space: { id: "" },
          permissions: { scopes: [], workScopes: [], viewerScopes: [] },
        },
      } as T;
    }
    if (message.type === "cohub.work.checkout-state") {
      return {
        type: "cohub.work.checkout-state.result",
        status: null,
        orderId: null,
      } as T;
    }

    const timeoutMs = options?.timeoutMs ?? 120_000;
    const requestId = generateRequestId();

    // Resolve the workId before opening the popup. When warmed at construction
    // this is an already-settled promise, so the await is a microtask and the
    // popup still opens within the user-activation window.
    const workId = await this.resolveWorkId();
    if (!workId) {
      throw new Error(
        "Unable to resolve the work id for broker mode. Provide `workId` or a valid slug triple (ownerUsername, spaceSlug, workSlug).",
      );
    }

    return new Promise<T | null>((resolve, reject) => {
      if (typeof window === "undefined" || typeof window.open !== "function") {
        resolve(null);
        return;
      }

      const workOrigin = window.location.origin;
      const brokerUrl = `${this.brokerOrigin}/work-auth?work=${encodeURIComponent(workId)}&origin=${encodeURIComponent(workOrigin)}`;

      const popup = window.open(brokerUrl, "cohub-work-auth", "popup,width=480,height=640");
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
        if (data.type === "cohub.work.broker.ready" && !ready) {
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
          if (data.type === "cohub.work.error") {
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

const TOKEN_STORAGE_PREFIX = "cohub:work-token";

const AUTHORIZED_SCOPES_STORAGE_PREFIX = "cohub:work-auth-scopes";

export class WorkRuntimeApi {
  private token: string | null = null;
  private readonly transport: WorkRuntimeTransport;
  private tokenStorageKey: string | null;
  private scopesStorageKey: string | null;
  private readonly workIdResolver?: WorkIdResolver;
  /** Ensures storage keys are resolved (via slug lookup) at most once. */
  private storageKeysReady: Promise<void> | null;
  /** Scopes previously granted via requestAuthorization, retained so token
   * refreshes can re-authorize (preserving viewerScopes) instead of falling
   * back to a base session token that only carries workScopes. */
  private authorizedScopes: Permission[] | null = null;

  constructor(
    transport: WorkRuntimeTransport = new ParentBridgeTransport(),
    workId?: string,
    workIdResolver?: WorkIdResolver,
  ) {
    this.transport = transport;
    this.workIdResolver = workIdResolver;
    if (workId) {
      // workId known up-front — keys are immediately available.
      this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${workId}`;
      this.scopesStorageKey = `${AUTHORIZED_SCOPES_STORAGE_PREFIX}:${workId}`;
      this.storageKeysReady = Promise.resolve();
      // Restore a cached token from localStorage (broker-mode UX optimization;
      // see §0 — this is not a security measure).
      this.token = this.readStoredToken();
      this.authorizedScopes = this.readStoredScopes();
    } else if (workIdResolver) {
      // workId resolved lazily via slug reverse lookup. Storage keys — and any
      // cached token — become available only after the lookup completes.
      this.tokenStorageKey = null;
      this.scopesStorageKey = null;
      this.storageKeysReady = null;
    } else {
      this.tokenStorageKey = null;
      this.scopesStorageKey = null;
      this.storageKeysReady = Promise.resolve();
    }
  }

  /**
   * Resolves the localStorage keys once the workId is known. When the workId is
   * only available via slug reverse lookup, this performs the lookup on first
   * use and then restores any cached token/scopes for that workId.
   */
  private ensureStorageKeys(): Promise<void> {
    if (this.storageKeysReady) return this.storageKeysReady;
    this.storageKeysReady = (async () => {
      const workId = this.workIdResolver ? await this.workIdResolver() : null;
      if (workId) {
        this.tokenStorageKey = `${TOKEN_STORAGE_PREFIX}:${workId}`;
        this.scopesStorageKey = `${AUTHORIZED_SCOPES_STORAGE_PREFIX}:${workId}`;
        // Now that keys are known, hydrate from localStorage.
        const stored = this.readStoredToken();
        if (stored && !this.token) this.token = stored;
        const storedScopes = this.readStoredScopes();
        if (storedScopes && !this.authorizedScopes) this.authorizedScopes = storedScopes;
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

  private readStoredScopes(): Permission[] | null {
    if (!this.scopesStorageKey || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.scopesStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((s) => typeof s === "string")
        ? (parsed as Permission[])
        : null;
    } catch {
      return null;
    }
  }

  private writeStoredScopes(scopes: Permission[] | null) {
    if (!this.scopesStorageKey || typeof localStorage === "undefined") return;
    try {
      if (scopes && scopes.length > 0) localStorage.setItem(this.scopesStorageKey, JSON.stringify(scopes));
      else localStorage.removeItem(this.scopesStorageKey);
    } catch {
      // ignore storage failures
    }
  }

  async context() {
    const response = await this.transport.request<{ context: WorkRuntimeContext }>(
      { type: "cohub.work.context" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    return response?.context ?? null;
  }

  async getAccessToken(options?: { forceRefresh?: boolean }) {
    await this.ensureStorageKeys();
    if (this.token && !options?.forceRefresh) return this.token;
    if (options?.forceRefresh) {
      this.token = null;
      this.writeStoredToken(null);
    }
    // When refreshing a token, if the work previously obtained viewer
    // scopes via requestAuthorization, re-authorize so the refreshed token
    // retains those viewerScopes. A plain /session token only carries
    // workScopes, which would cause 403 on viewer-scoped operations.
    if (options?.forceRefresh && this.authorizedScopes && this.authorizedScopes.length > 0) {
      const response = await this.transport.request<{ token: string | null }>(
        { type: "cohub.work.authorize", scopes: this.authorizedScopes },
        { timeoutMs: 120_000 },
      );
      this.token = response?.token ?? null;
      this.writeStoredToken(this.token);
      return this.token;
    }
    const response = await this.transport.request<{ token: string | null }>(
      { type: "cohub.work.token", forceRefresh: Boolean(options?.forceRefresh) },
      { timeoutMs: 20_000 },
    );
    this.token = response?.token ?? null;
    this.writeStoredToken(this.token);
    return this.token;
  }

  async requestAuthorization(input: { scopes: Permission[]; reason?: string }) {
    await this.ensureStorageKeys();
    const response = await this.transport.request<{ token: string | null }>(
      { type: "cohub.work.authorize", scopes: input.scopes, reason: input.reason },
      { timeoutMs: 120_000 },
    );
    this.token = response?.token ?? null;
    this.writeStoredToken(this.token);
    if (this.token) {
      this.authorizedScopes = input.scopes;
      this.writeStoredScopes(input.scopes);
    }
    return Boolean(this.token);
  }

  async purchase(input: { productKey: string; purchaseAttemptId?: string }) {
    const purchaseAttemptId = input.purchaseAttemptId?.trim() || generateRequestId();
    const response = await this.transport.request<{ checkout: { providerKey: string | null; checkoutUrl: string | null; checkoutUsable: boolean; status: string | null; message: string | null; orderId: string; productKey: string } | null }>(
      {
        type: "cohub.work.purchase",
        productKey: input.productKey,
        purchaseAttemptId,
      },
      { timeoutMs: 120_000 },
    );
    return response?.checkout ?? null;
  }

  async checkoutState() {
    const response = await this.transport.request<WorkRuntimeCheckoutState>(
      { type: "cohub.work.checkout-state" },
      { timeoutMs: 8_000, retryIntervalMs: 250 },
    );
    return response ?? null;
  }

  async searchNetaCharacters(input: {
    keywords?: string;
    pageIndex?: number;
    pageSize?: number;
  } = {}) {
    const response = await this.transport.request<{
      page?: WorkRuntimeNetaCharacterPage;
    }>(
      {
        type: "cohub.neta.characters",
        operation: "search",
        keywords: input.keywords?.trim() ?? "",
        pageIndex: input.pageIndex,
        pageSize: input.pageSize,
      },
      { timeoutMs: 20_000 },
    );
    return response?.page ?? null;
  }

  async listNetaCharacterFavorites(input: {
    pageIndex?: number;
    pageSize?: number;
  } = {}) {
    const response = await this.transport.request<{
      page?: WorkRuntimeNetaCharacterPage;
    }>(
      {
        type: "cohub.neta.characters",
        operation: "favorites",
        pageIndex: input.pageIndex,
        pageSize: input.pageSize,
      },
      { timeoutMs: 20_000 },
    );
    return response?.page ?? null;
  }

  async setNetaCharacterFavorite(uuid: string, isCancel = false) {
    const response = await this.transport.request<{ ok?: boolean }>(
      {
        type: "cohub.neta.characters",
        operation: "favorite",
        uuid,
        isCancel,
      },
      { timeoutMs: 20_000 },
    );
    return response?.ok === true;
  }
}

/**
 * Configuration for the work runtime mode.
 */
export type WorkRuntimeModeConfig = {
  /** Explicit mode selection. When omitted, auto-detection is used. */
  mode?: "bridge" | "broker";
  /** Cohub origin for the broker page (e.g. "https://cohub.run"). */
  brokerOrigin?: string;
  /**
   * The work's public id. Required for broker mode unless the slug triple
   * below is supplied, in which case the id is resolved at runtime.
   */
  workId?: string;
  /** Space owner's username. Used with {@link spaceSlug} + {@link workSlug} to
   * resolve the workId at runtime via the public `works.getBySlug` API. */
  ownerUsername?: string;
  /** Space slug. Part of the slug triple used for runtime workId resolution. */
  spaceSlug?: string;
  /** Work slug. Part of the slug triple used for runtime workId resolution. */
  workSlug?: string;
};

/** Lazily resolves a work's public id, e.g. via slug reverse lookup. */
export type WorkIdResolver = () => Promise<string | null>;

/**
 * Builds a memoized workId resolver that reverse-looks-up the workId from the
 * public slug triple via `GET /api/works/by-slug/:username/:spaceSlug/:workSlug`.
 * The endpoint is anonymous (no auth) for public works, so no token is needed.
 * The result is cached; a failed lookup is not cached so it can be retried.
 */
export function createSlugWorkIdResolver(deps: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  ownerUsername: string;
  spaceSlug: string;
  workSlug: string;
}): WorkIdResolver {
  let cached: Promise<string | null> | null = null;
  return () => {
    if (cached) return cached;
    const run = (async (): Promise<string | null> => {
      const doFetch = deps.fetch ?? globalThis.fetch;
      if (typeof doFetch !== "function") return null;
      const url = `${deps.apiBaseUrl}/api/works/by-slug/${encodeURIComponent(deps.ownerUsername)}/${encodeURIComponent(deps.spaceSlug)}/${encodeURIComponent(deps.workSlug)}`;
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
 * Resolves the appropriate transport based on the work mode configuration.
 * Auto-detection: inside an iframe → bridge; standalone with broker config →
 * broker; otherwise → bridge (returns null for non-work contexts).
 */
export function resolveWorkTransport(
  config?: WorkRuntimeModeConfig,
  workIdResolver?: WorkIdResolver,
): WorkRuntimeTransport {
  const explicitMode = config?.mode;
  const brokerOrigin = config?.brokerOrigin;
  const workId = config?.workId;
  const canResolveWorkId = Boolean(workId || workIdResolver);
  const hasBrokerConfig = Boolean(brokerOrigin && canResolveWorkId);

  const createBroker = (): WorkRuntimeTransport =>
    brokerOrigin && canResolveWorkId
      ? new PopupBrokerTransport({ brokerOrigin, workId, getWorkId: workIdResolver })
      : new ParentBridgeTransport();

  if (explicitMode === "bridge") return new ParentBridgeTransport();
  if (explicitMode === "broker") return createBroker();

  // Auto-detect
  if (typeof window !== "undefined" && window.parent !== window) {
    // Inside an iframe → bridge mode
    return new ParentBridgeTransport();
  }
  // Standalone: use broker if configured, otherwise fall back to bridge
  // (which returns null when there is no parent — the SDK simply isn't in a
  // work runtime context).
  return hasBrokerConfig ? createBroker() : new ParentBridgeTransport();
}

export const createWorkRuntime = (
  transport?: WorkRuntimeTransport,
  workId?: string,
  workIdResolver?: WorkIdResolver,
) => new WorkRuntimeApi(transport, workId, workIdResolver);
