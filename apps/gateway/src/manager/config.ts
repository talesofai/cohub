import type { DiscordCentralChannelCredentials } from "@cohub/protocol";

interface DiscordChannelConfig {
  provider: "discord";
  credentials: {
    token: string;
  };
  externalChatId?: string;
}

interface DiscordCentralProviderConfig {
  provider: "discord_central";
  credentials: DiscordCentralChannelCredentials;
  externalChatId?: string;
}

interface FeishuChannelConfig {
  provider: "feishu";
  credentials: {
    appId: string;
    appSecret: string;
    brand: "feishu" | "lark";
  };
  externalChatId?: string;
}

export type GatewayNodeChannelConfig =
  | DiscordChannelConfig
  | DiscordCentralProviderConfig
  | FeishuChannelConfig;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readNullableString = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
};

const readDiscordEntryMode = (
  value: unknown,
): DiscordCentralChannelCredentials["entryMode"] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return value === "dm" || value === "guild" || value === "any" ? value : undefined;
};

export const parseChannelConfig = (raw: unknown): GatewayNodeChannelConfig | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const provider = readString(raw.provider);
  const credentials = isRecord(raw.credentials) ? raw.credentials : null;
  if (!provider || !credentials) {
    return null;
  }

  const externalChatId = readOptionalString(raw.externalChatId);

  switch (provider) {
    case "discord": {
      const token = readString(credentials.token);
      if (!token) {
        return null;
      }
      return {
        provider,
        credentials: { token },
        externalChatId,
      };
    }
    case "discord_central": {
      const discordUserId = readString(credentials.discordUserId);
      if (!discordUserId) {
        return null;
      }
      return {
        provider,
        credentials: {
          discordUserId,
          entryMode: readDiscordEntryMode(credentials.entryMode),
          guildId: readNullableString(credentials.guildId),
          channelId: readNullableString(credentials.channelId),
          threadId: readNullableString(credentials.threadId),
        },
        externalChatId,
      };
    }
    case "feishu": {
      const appId = readString(credentials.appId);
      const appSecret = readString(credentials.appSecret);
      const brand = credentials.brand === "lark" ? "lark" : "feishu";
      if (!appId || !appSecret) {
        return null;
      }
      return {
        provider,
        credentials: {
          appId,
          appSecret,
          brand,
        },
        externalChatId,
      };
    }
    default:
      return null;
  }
};
