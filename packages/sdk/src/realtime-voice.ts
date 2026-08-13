import type { CohubEnvironment } from "./environment.js";
import { resolveRealtimeVoiceWebsocketUrl } from "./environment.js";

export type RealtimeVoiceEvent = Record<string, unknown> & { type: string };

export type RealtimeVoiceCallbacks = {
  onEvent?: (event: RealtimeVoiceEvent) => void;
  onError?: (message: string) => void;
  onClose?: (code: number, reason: string) => void;
};

export type RealtimeVoiceClientOptions = {
  env?: CohubEnvironment;
  url?: string;
  /** Opens a full-duplex calling session instead of the default TTS-only session (see cohub's apps/gateway realtime-voice route). */
  calling?: boolean;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null> | string | null;
  WebSocketImpl?: WebSocketConstructor;
  connectionTimeoutMs?: number;
  callbacks?: RealtimeVoiceCallbacks;
};

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const WEBSOCKET_OPEN = 1;

const getDefaultWebSocket = (): WebSocketConstructor => {
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error("WebSocket is not available in this environment");
  return WebSocketImpl as unknown as WebSocketConstructor;
};

const extractErrorMessage = (event: RealtimeVoiceEvent): string => {
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "Realtime voice error";
};

/**
 * Thin client for cohub's realtime voice gateway (apps/gateway's
 * /v1/realtime, relayed through neta-router to new-api). This class does not
 * interpret, validate, or transform events -- it only handles connection
 * setup and framing. Speak the OpenAI Realtime API event protocol directly
 * via `send`/`onEvent`.
 *
 * Auth travels in the WebSocket handshake as a `x-token.<value>`
 * Sec-WebSocket-Protocol entry, not an in-band message (unlike
 * VoiceInputClient's ASR protocol) -- the native WebSocket API can't set
 * custom headers but can set subprotocols, and keeping auth out of the
 * message stream keeps the wire protocol a plain OpenAI-Realtime-compatible
 * connection so standard realtime client tooling can be layered on top
 * unmodified.
 */
export class RealtimeVoiceClient {
  private readonly baseUrl: string;
  private readonly calling: boolean;
  private readonly getAccessToken?: RealtimeVoiceClientOptions["getAccessToken"];
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly connectionTimeoutMs: number;
  private readonly callbacks: RealtimeVoiceCallbacks;

  private socket: WebSocketLike | null = null;

  constructor(options: RealtimeVoiceClientOptions = {}) {
    this.baseUrl = resolveRealtimeVoiceWebsocketUrl({ env: options.env, url: options.url });
    this.calling = options.calling ?? false;
    this.getAccessToken = options.getAccessToken;
    this.WebSocketImpl = options.WebSocketImpl ?? getDefaultWebSocket();
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.callbacks = options.callbacks ?? {};
  }

  get readyState(): number {
    return this.socket?.readyState ?? -1;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WEBSOCKET_OPEN) return;

    const token = await this.getAccessToken?.();
    if (!token) throw new Error("Sign in to use realtime voice");

    const url = this.calling ? `${this.baseUrl}?calling=true` : this.baseUrl;
    const socket = new this.WebSocketImpl(url, [`x-token.${token}`]);
    this.socket = socket;

    await this.withConnectionTimeout(
      new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Realtime voice connection failed"));
      }),
    );

    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => this.callbacks.onError?.("Realtime voice connection error");
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.callbacks.onClose?.(event.code, event.reason);
    };
  }

  /** Sends a raw OpenAI Realtime API event (e.g. session.update, input_audio_buffer.append, response.create). */
  send(event: RealtimeVoiceEvent): void {
    if (this.socket?.readyState !== WEBSOCKET_OPEN) throw new Error("Realtime voice connection is not open");
    this.socket.send(JSON.stringify(event));
  }

  close(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
    this.socket = null;
  }

  private handleMessage(event: MessageEvent): void {
    let data: RealtimeVoiceEvent;
    try {
      data = JSON.parse(String(event.data)) as RealtimeVoiceEvent;
    } catch {
      this.callbacks.onError?.("Realtime voice service sent invalid data");
      return;
    }
    if (data.type === "error") this.callbacks.onError?.(extractErrorMessage(data));
    this.callbacks.onEvent?.(data);
  }

  private async withConnectionTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = globalThis.setTimeout(
            () => reject(new Error("Realtime voice connection timed out")),
            this.connectionTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) globalThis.clearTimeout(timeout);
    }
  }
}

export const createRealtimeVoiceClient = (options?: RealtimeVoiceClientOptions) => new RealtimeVoiceClient(options);
