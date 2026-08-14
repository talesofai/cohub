export type CohubEnvironment = "prod" | "dev";

export const COHUB_ENVIRONMENTS = {
  prod: {
    apiBaseUrl: "https://api.cohub.run",
    websocketUrl: "wss://gateway.cohub.run/ws",
    voiceInputWebsocketUrl: "wss://gateway.cohub.run/asr/ws",
    realtimeVoiceWebsocketUrl: "wss://gateway.cohub.run/v1/realtime",
  },
  dev: {
    apiBaseUrl: "https://api-dev.cohub.run",
    websocketUrl: "wss://gateway-dev.cohub.run/ws",
    voiceInputWebsocketUrl: "wss://gateway-dev.cohub.run/asr/ws",
    realtimeVoiceWebsocketUrl: "wss://gateway-dev.cohub.run/v1/realtime",
  },
} as const satisfies Record<
  CohubEnvironment,
  { apiBaseUrl: string; websocketUrl: string; voiceInputWebsocketUrl: string; realtimeVoiceWebsocketUrl: string }
>;

const readRuntimeEnv = (): string | undefined => {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.ENV;
};

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

export const normalizeRealtimeVoiceWebsocketUrl = (input: string) =>
  normalizeWebsocketPath(input, "/v1/realtime", ["/ws", "/asr/ws"]);

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

export const resolveRealtimeVoiceWebsocketUrl = (options: {
  url?: string;
  env?: CohubEnvironment;
} = {}) => {
  if (options.url) return normalizeRealtimeVoiceWebsocketUrl(options.url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].realtimeVoiceWebsocketUrl;
};
