export type ChannelProvider =
  | "web"
  | "discord"
  | "discord_central"
  | "feishu"
  | "telegram"
  | "slack";

export type DiscordCentralEntryMode = "dm" | "guild" | "any";

/**
 * 根据入站事件生成来源渠道名称
 * - discord:dm:{sender_name} - 私信
 * - discord:{guild_name}:#{channel_name} - 频道
 * - discord:{guild_name}:#{parent_channel}>{thread_name} - 线程
 * - web - Web 端
 * - {provider}:{chat_id} - 其他 fallback
 */
export function buildSessionSourceChannel(event: GatewayInboundEvent): string {
  const provider = event.provider;
  const meta = (event.conversation?.meta ?? event.meta ?? {}) as Record<string, unknown>;

  switch (provider) {
    case "discord":
    case "discord_central":
      return buildDiscordSourceChannel(event, meta);
    case "feishu":
      return buildFeishuSourceChannel(event, meta);
    case "web":
      return "web";
    default:
      return `${provider}:${event.conversation?.id?.trim() || event.externalChatId}`;
  }
}

function buildDiscordSourceChannel(event: GatewayInboundEvent, meta: Record<string, unknown>): string {
  const isDm = meta.isDm === true;
  const guildName = typeof meta.guildName === "string" ? meta.guildName : null;
  const channelName = typeof meta.channelName === "string" ? meta.channelName : null;
  const parentChannelName = typeof meta.parentChannelName === "string" ? meta.parentChannelName : null;
  const threadName = typeof meta.threadName === "string" ? meta.threadName : null;
  const senderName = event.sender?.name ?? null;

  if (isDm) {
    return `discord:dm:${senderName ?? event.sender.id}`;
  }
  if (threadName && parentChannelName && guildName) {
    return `discord:${guildName}:#${parentChannelName}>${threadName}`;
  }
  if (channelName && guildName) {
    return `discord:${guildName}:#${channelName}`;
  }
  if (guildName) {
    return `discord:${guildName}`;
  }
  return `discord:${event.conversation?.id?.trim() || event.externalChatId}`;
}

function buildFeishuSourceChannel(event: GatewayInboundEvent, meta: Record<string, unknown>): string {
  const chatType = meta.chatType as string | undefined;
  const chatName = typeof meta.chatName === "string" ? meta.chatName : null;
  const senderName = event.sender?.name ?? null;
  const isDm = chatType === "p2p";

  if (isDm) {
    return `feishu:dm:${senderName ?? event.sender.id}`;
  }
  if (chatName) {
    return `feishu:group:${chatName}`;
  }
  return `feishu:${event.conversation?.id?.trim() || event.externalChatId}`;
}

export interface DiscordChannelConfig {
  inbound?: {
    requireMentionInGuild?: boolean;
  };
  outbound?: {
    showThinking?: boolean;
    showToolCalls?: boolean;
  };
}

export interface DiscordCentralChannelCredentials {
  discordUserId: string;
  entryMode?: DiscordCentralEntryMode;
  guildId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
}

export type DiscordCentralChannelConfig = DiscordChannelConfig;

export type ChannelConfig =
  | DiscordChannelConfig
  | DiscordCentralChannelConfig
  | FeishuChannelConfig
  | Record<string, unknown>;

export interface FeishuChannelConfig {
  brand?: "feishu" | "lark";
  inbound?: {
    requireMentionInGroup?: boolean;
  };
  outbound?: {
    renderMode?: "card" | "post";
    showThinking?: boolean;
    showToolCalls?: boolean;
  };
}

export interface GatewayInboundEvent {
  eventId: string;
  timestamp: number;
  eventType?: "message_create" | "conversation_create";

  channelId: string;
  provider: ChannelProvider;
  externalChatId: string;
  externalMessageId: string;
  bindingKey?: string;

  conversation: {
    id: string;
    parentId?: string | null;
    meta?: Record<string, unknown> | null;
  };
  message?: {
    parentMessageId?: string | null;
    meta?: Record<string, unknown> | null;
  };

  sender: {
    id: string;
    name?: string;
  };
  content: import("./session-ingestion.js").ContentBlock[];
  meta?: Record<string, unknown> | null;
}

export interface GatewayOutboundCommand {
  commandId: string;
  timestamp: number;

  channelId: string;
  provider: ChannelProvider;
  externalChatId: string;

  content: import("./session-ingestion.js").ContentBlock[];

  replyToExternalMessageId?: string;
  runtimeId?: string;
  runtimeSessionId?: string;
  sessionMessageId?: string;
  meta?: Record<string, unknown> | null;
}

export interface GatewayControlCommand {
  action: "connect" | "disconnect" | "reload";
  configs: {
    channelId: string;
    provider: ChannelProvider;
    credentials: Record<string, unknown>;
  }[];
}

export type GatewayLogDirection = "inbound" | "outbound";
export type GatewayLogStatus = "pending" | "success" | "failed";

export interface GatewayLogEvent {
  logId: string;
  timestamp: number;
  direction: GatewayLogDirection;
  provider: ChannelProvider;
  channelId: string;
  externalChatId: string;
  externalMessageId?: string;

  rawPayload: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;

  status: GatewayLogStatus;
  errorMessage?: string;

  /** 关联的事件/命令 ID，便于追踪 */
  correlationId?: string;
}
