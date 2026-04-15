const normalizeBaseUrl = (value: string) => value.replace(/\/$/, "");
const readPositiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const gatewayConfig = {
  apiBaseUrl: normalizeBaseUrl(process.env.API_BASE_URL ?? "http://localhost:8787"),
  discordCentralBaseUrl: normalizeBaseUrl(
    process.env.DISCORD_CENTRAL_BASE_URL ?? "http://localhost:8790",
  ),
  discordCentralSecret: process.env.DISCORD_CENTRAL_SECRET ?? "",
  discordCentralTimeoutMs: readPositiveNumber(process.env.DISCORD_CENTRAL_TIMEOUT_MS, 10000),
  port: Number(process.env.PORT ?? 8788),
};

export type GatewayAuthUser = {
  uuid: string;
  nick_name?: string;
  avatar_url?: string;
  [key: string]: unknown;
};
