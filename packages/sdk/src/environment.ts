export type CohubEnvironment = "prod" | "dev";

export const COHUB_ENVIRONMENTS = {
  prod: {
    apiBaseUrl: "https://api.cohub.live",
    websocketUrl: "wss://gateway.cohub.live/ws",
    voiceInputWebsocketUrl: "wss://gateway.cohub.live/asr/ws",
  },
  dev: {
    apiBaseUrl: "https://api-dev.cohub.live",
    websocketUrl: "wss://gateway-dev.cohub.live/ws",
    voiceInputWebsocketUrl: "wss://gateway-dev.cohub.live/asr/ws",
  },
} as const satisfies Record<CohubEnvironment, { apiBaseUrl: string; websocketUrl: string; voiceInputWebsocketUrl: string }>;

const readProcessEnv = (): Record<string, string | undefined> | undefined => {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env;
};

const readRuntimeEnv = (): string | undefined => readProcessEnv()?.ENV;

/** Existing scoped identity injected into Sandbox command processes. */
export const resolveExecutionToken = (): string | null =>
  readProcessEnv()?.COHUB_EXECUTION_TOKEN?.trim() || null;

export function resolveExecutionAppId(): string | null {
  const payload = resolveExecutionToken()?.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const appId = (JSON.parse(globalThis.atob(base64)) as { appId?: unknown }).appId;
    return typeof appId === "string" && appId ? appId : null;
  } catch {
    return null;
  }
}

export const resolveCohubEnvironment = (env?: CohubEnvironment): CohubEnvironment => {
  if (env) return env;
  return readRuntimeEnv() === "dev" ? "dev" : "prod";
};

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

const normalizeWebsocketPath = (input: string, path: string, replacePaths: string[] = []) => {
  let withProtocol = normalizeBaseUrl(input)
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  for (const replacePath of replacePaths) {
    if (withProtocol.endsWith(replacePath)) {
      withProtocol = withProtocol.slice(0, -replacePath.length);
      break;
    }
  }
  return withProtocol.endsWith(path) ? withProtocol : `${withProtocol}${path}`;
};

export const normalizeWebsocketUrl = (input: string) => normalizeWebsocketPath(input, "/ws", ["/asr/ws"]);

export const normalizeVoiceInputWebsocketUrl = (input: string) =>
  normalizeWebsocketPath(input, "/asr/ws", ["/ws"]);

export const resolveApiBaseUrl = (options: {
  baseUrl?: string;
  env?: CohubEnvironment;
} = {}) => {
  if (options.baseUrl) return normalizeBaseUrl(options.baseUrl);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].apiBaseUrl;
};

export const resolveWebsocketUrl = (options: {
  url?: string;
  env?: CohubEnvironment;
} = {}) => {
  if (options.url) return normalizeWebsocketUrl(options.url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].websocketUrl;
};

export const resolveVoiceInputWebsocketUrl = (options: {
  url?: string;
  env?: CohubEnvironment;
} = {}) => {
  if (options.url) return normalizeVoiceInputWebsocketUrl(options.url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].voiceInputWebsocketUrl;
};
