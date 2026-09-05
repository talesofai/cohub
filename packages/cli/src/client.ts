import { CohubClient, CohubHttpClient, readRequestSourceFromEnv } from "@neta-art/cohub";
import { clearAuthSession, resolveAccessToken } from "./auth.js";

const clientOptions = () => ({
  getAccessToken: resolveAccessToken,
  onUnauthorized: clearAuthSession,
  requestSource: () =>
    readRequestSourceFromEnv(process.env as Record<string, string | undefined>, { via: "cli" }) ?? {
      via: "cli" as const,
    },
});

export function createClient(): CohubHttpClient {
  return new CohubHttpClient(clientOptions());
}

export function createClientWithAccessToken(token: string): CohubHttpClient {
  return new CohubHttpClient({ ...clientOptions(), getAccessToken: () => token });
}

export function createRealtimeClient(): CohubClient {
  return new CohubClient(clientOptions());
}
