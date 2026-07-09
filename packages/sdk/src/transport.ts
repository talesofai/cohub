import type { CohubEnvironment } from "./environment.js";
import { resolveApiBaseUrl } from "./environment.js";
import type { WebsocketClientOptions } from "./websocket.js";
import type { VoiceInputCreateOptions } from "./voice-input.js";
import type { WorkRuntimeModeConfig } from "./work-runtime.js";

export type Fetch = typeof globalThis.fetch;

type RequestInitWithFetch = RequestInit & { fetch?: Fetch };

const responseBodyForError = async (response: Response) => {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => response.statusText);
};

const messageFromErrorBody = (body: unknown, fallback: string) => {
  if (typeof body === "string") return body.trim() || fallback;
  if (body && typeof body === "object") {
    const errorBody = body as { message?: unknown };
    if (typeof errorBody.message === "string" && errorBody.message.trim()) return errorBody.message;
  }
  return fallback;
};

export type RawHttpResponse = {
  response: Response;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type CohubClientOptions = {
  env?: CohubEnvironment;
  baseUrl?: string;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null> | string | null;
  onUnauthorized?: () => Promise<void> | void;
  setStoredAuthToken?: (token: string) => void;
  clearStoredAuthToken?: () => void;
  fetch?: Fetch;
  websocket?: WebsocketClientOptions;
  voice?: VoiceInputCreateOptions;
  /** Work runtime mode configuration (bridge vs broker). */
  work?: WorkRuntimeModeConfig;
};

function errorCodeFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const errorBody = body as { code?: unknown };
  if (typeof errorBody.code === "string" && errorBody.code.trim()) return errorBody.code;
  return null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | null;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.code = errorCodeFromBody(body);
  }
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly fetcher: Fetch;
  private readonly getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null> | string | null;
  private readonly onUnauthorized?: () => Promise<void> | void;

  constructor(options: CohubClientOptions = {}) {
    this.baseUrl = resolveApiBaseUrl(options);
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.onUnauthorized = options.onUnauthorized;
  }

  private async withAuthorization(init?: RequestInit, tokenOverride?: string | null): Promise<RequestInit> {
    const headers = new Headers(init?.headers);
    const token = tokenOverride ?? (this.getAccessToken ? await this.getAccessToken() : null);

    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else {
      headers.delete("Authorization");
    }

    return {
      ...init,
      headers,
    };
  }

  private async send(path: string, init?: RequestInitWithFetch) {
    const fetcher = init?.fetch ?? this.fetcher;
    const url = this.baseUrl ? `${this.baseUrl}${path}` : path;
    const response = await fetcher(url, await this.withAuthorization(init));

    const getAccessToken = this.getAccessToken;
    if (response.status === 401 && getAccessToken) {
      const refreshedToken = await (async () => {
        try {
          return await getAccessToken({ forceRefresh: true });
        } catch {
          return null;
        }
      })();
      if (refreshedToken) {
        const retryResponse = await fetcher(url, await this.withAuthorization(init, refreshedToken));
        if (retryResponse.status !== 401) {
          if (!retryResponse.ok) {
            const body = await responseBodyForError(retryResponse);
            throw new HttpError(
              messageFromErrorBody(body, retryResponse.statusText),
              retryResponse.status,
              body,
            );
          }
          return retryResponse;
        }
      }
    }

    if (response.status === 401) {
      await this.onUnauthorized?.();
      throw new HttpError("unauthorized", 401, null);
    }

    if (!response.ok) {
      const body = await responseBodyForError(response);
      throw new HttpError(
        messageFromErrorBody(body, response.statusText),
        response.status,
        body,
      );
    }

    return response;
  }

  async request<T>(path: string, init?: RequestInitWithFetch) {
    const response = await this.send(path, init);

    if (response.status === 204) {
      return null as T;
    }

    return response.json() as Promise<T>;
  }

  async raw(path: string, init?: RequestInitWithFetch): Promise<RawHttpResponse> {
    const response = await this.send(path, init);
    return {
      response,
      blob: () => response.blob(),
      arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(),
      json: () => response.json(),
    };
  }

  async blob(path: string, init?: RequestInitWithFetch) {
    const raw = await this.raw(path, init);
    return raw.blob();
  }
}
