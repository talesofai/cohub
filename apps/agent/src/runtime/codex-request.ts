import type { Api, Model, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isGptResponsesModel } from "@cohub/infra/config-runtime/models";

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
  const expectedName = name.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === expectedName) delete headers[existingName];
  }
  headers[name] = value;
}

export function withCodexSessionAffinity(
  model: Model<Api>,
  options: SimpleStreamOptions,
  sessionId: string | undefined,
): SimpleStreamOptions {
  if (!sessionId || !isGptResponsesModel(model)) return options;

  const headers = { ...(options.headers ?? {}) };
  setHeader(headers, "Session-Id", sessionId);
  setHeader(headers, "Thread-Id", sessionId);
  setHeader(headers, "X-Client-Request-Id", sessionId);
  return { ...options, sessionId, headers };
}
