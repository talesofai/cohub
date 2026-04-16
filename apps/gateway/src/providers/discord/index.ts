import { Client, GatewayIntentBits, Partials, type AnyThreadChannel, type Message, Events, type MessageCreateOptions, type TextBasedChannel } from "discord.js";
import { randomUUID } from "node:crypto";
import type { GatewayInboundEvent, GatewayOutboundCommand, ContentBlock, DiscordChannelConfig } from "@cohub/protocol";
import type { GatewayProvider } from "../base.js";
import { publishConversationCreateEvent, publishInboundEvent } from "../../bus.js";
import { getSpaceChannelConfig, getTurnMessageExternalRef, setTurnMessageExternalRef } from "../../redis.js";

const buildDiscordBindingKey = (message: Message) => {
  return `discord:conversation:${message.channelId}`;
};

const truncate = (value: string, limit = 120) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const splitDiscordMessage = (value: string, limit = 1900) => {
  const text = value.trim();
  if (!text) return [] as string[];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const breakIndex = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(" "),
    );
    const cut = breakIndex > Math.floor(limit * 0.5) ? breakIndex : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
};

const summarizeThinkingForMinimal = (thinking: string) => {
  const trimmed = thinking.trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  return truncate(firstLine, 100);
};

const buildToolLine = (status: string | undefined, toolName: string | undefined, summary: string | undefined) => {
  const safeStatus = status ?? "queued";
  const safeToolName = toolName ?? "tool";
  const suffix = summary?.trim() ? ` ${summary.trim()}` : "";
  return `[${safeStatus}] ${safeToolName}${suffix}`;
};

const buildDiscordRenderText = (content: ContentBlock[], includeThinking = false, isFinalMessage = false) => {
  const textParts: string[] = [];
  const imageUris: string[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "thinking") {
      if (includeThinking && !isFinalMessage) {
        const summary = summarizeThinkingForMinimal(block.thinking);
        if (summary) textParts.push(`> ${summary}`);
      }
      continue;
    }

    if (block.type === "tool_use") {
      if (isFinalMessage) continue;
      const name = block.name;
      const inputSummary = block.input && typeof block.input === "object"
        ? Object.values(block.input as Record<string, unknown>).filter(v => typeof v === "string").join(" ").slice(0, 80)
        : "";
      textParts.push(`[done] ${name}${inputSummary ? ` ${inputSummary}` : ""}`);
      continue;
    }

    if (block.type === "tool_result") {
      // Tool results are typically not shown in final messages
      continue;
    }

    if (block.type === "image" && block.source.type === "url") {
      imageUris.push(block.source.url);
      continue;
    }

    if (block.type === "system_note") {
      textParts.push(`ℹ️ ${block.text}`);
    }
  }

  const mergedText = textParts.join("\n").trim();
  return {
    text: mergedText,
    imageUris,
  };
};

const getDiscordOutboundConfig = (config: DiscordChannelConfig | null | undefined) => {
  const outbound = config?.outbound ?? {};
  return {
    showThinking: outbound.showThinking === true,
    showToolCalls: outbound.showToolCalls === true,
  };
};

const getDiscordInboundConfig = (config: DiscordChannelConfig | null | undefined) => {
  const inbound = config?.inbound ?? {};
  return {
    requireMentionInGuild: inbound.requireMentionInGuild !== false,
  };
};

/**
 * Resolve Discord mention patterns to readable names.
 * Converts <@USER_ID> → @username, <@&ROLE_ID> → @role, <#CHANNEL_ID> → #channel.
 * Bot's own mention is stripped entirely.
 */
const resolveMentions = (message: Message): string => {
  let content = message.content;
  const botUserId = message.client.user?.id;

  // Build a map of all mention IDs → display names, sorted by ID length descending
  // to avoid partial matches (e.g. shorter ID matching inside a longer one)
  const replacements: Map<string, string> = new Map();

  // Guild members have display names (nicknames), fall back to user.username
  for (const [id, member] of message.mentions.members ?? []) {
    const prefix = id === botUserId ? "__BOT__" : "@";
    replacements.set(id, `${prefix}${member.displayName}`);
  }
  // Users not in members (e.g. DMs)
  for (const [id, user] of message.mentions.users) {
    if (!replacements.has(id)) {
      const prefix = id === botUserId ? "__BOT__" : "@";
      replacements.set(id, `${prefix}${user.username}`);
    }
  }
  // Roles
  for (const [id, role] of message.mentions.roles ?? []) {
    replacements.set(`&${id}`, `@${role.name}`);
  }
  // Channels
  for (const [id, channel] of message.mentions.channels ?? []) {
    replacements.set(`#${id}`, `#${"name" in channel ? channel.name : id}`);
  }

  // Replace mentions by building a single regex, sorted by ID length descending
  const sortedEntries = [...replacements.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );

  for (const [id, name] of sortedEntries) {
    if (name.startsWith("__BOT__")) {
      // Strip bot mention entirely
      content = content.replace(new RegExp(`<@!?${id}>`, "g"), "");
    } else {
      const isUser = !id.startsWith("&") && !id.startsWith("#");
      const rawId = isUser ? id : id.slice(1);
      const pattern = isUser ? "<@!?(\\d+)>" : id.startsWith("&") ? "<@&(\\d+)>" : "<#(\\d+)>";
      content = content.replace(new RegExp(pattern, "g"), (match, capturedId) => {
        return capturedId === rawId ? name : match;
      });
    }
  }

  return content.replace(/\s{2,}/g, " ").trim();
};

const shouldAcceptDiscordInboundMessage = async (channelId: string, message: Message) => {
  const isDM = message.channel?.isDMBased?.() ?? false;
  if (isDM) return true;

  const channelConfig = await getSpaceChannelConfig<DiscordChannelConfig>(channelId);
  const inboundConfig = getDiscordInboundConfig(channelConfig);
  if (!inboundConfig.requireMentionInGuild) return true;

  const botUserId = message.client.user?.id;
  if (!botUserId) return false;
  return message.mentions.users.has(botUserId);
};

const buildDiscordOutboundPayload = async (channelId: string, cmd: GatewayOutboundCommand) => {
  const renderMode = String(cmd.meta?.renderMode ?? "message");
  const isFinalMessage = cmd.meta?.source === "session_persist";

  if (renderMode !== "rich_status") {
    return buildDiscordRenderText(cmd.content, !isFinalMessage, isFinalMessage);
  }

  const channelConfig = await getSpaceChannelConfig<DiscordChannelConfig>(channelId);
  const outboundConfig = getDiscordOutboundConfig(channelConfig);
  // Only show thinking for intermediate status updates, not final messages
  const thinking = !isFinalMessage && outboundConfig.showThinking && typeof cmd.meta?.thinking === "string" ? cmd.meta.thinking : "";
  const answer = typeof cmd.meta?.answer === "string" ? cmd.meta.answer : buildDiscordRenderText(cmd.content, false).text;
  const toolCalls = outboundConfig.showToolCalls && Array.isArray(cmd.meta?.toolCalls)
    ? cmd.meta.toolCalls as Array<Record<string, unknown>>
    : [];

  const lines: string[] = [];
  if (thinking.trim()) {
    lines.push(`> ${thinking.trim()}`);
  }
  if (toolCalls.length > 0) {
    lines.push(
      `${toolCalls
        .map((tool) => buildToolLine(
          typeof tool.status === "string" ? tool.status : undefined,
          typeof tool.toolName === "string" ? tool.toolName : undefined,
          typeof tool.summary === "string" ? tool.summary : undefined,
        ))
        .join("\n")}`,
    );
  }
  if (answer.trim()) {
    lines.push(answer.trim());
  }

  if (!isFinalMessage) {
    lines.push("🍳 cooking…");
  }

  return {
    text: lines.join("\n\n").trim(),
    imageUris: [],
  };
};

const buildThreadConversationMeta = async (thread: AnyThreadChannel) => {
  const fetchableThread = thread as AnyThreadChannel & { fetchStarterMessage?: () => Promise<Message | null> };
  const starter = await fetchableThread.fetchStarterMessage?.().catch(() => null);

  return {
    parentId: thread.parentId ?? null,
    starterMessageId: starter?.id ?? null,
    threadName: thread.name ?? null,
    archived: thread.archived ?? false,
    locked: thread.locked ?? false,
    autoArchiveDuration: thread.autoArchiveDuration ?? null,
  };
};

function resolveDiscordDisplayMode(_cmd: GatewayOutboundCommand) {
  return "full";
}

export class DiscordProvider implements GatewayProvider {
  private client: Client;
  private channelId: string; // 在我们的数据库中定义的该 Channel 实体 ID
  private isConnected = false;

  constructor(channelId: string, token: string) {
    this.channelId = channelId;
    console.log(`[Discord:${channelId}] Creating Discord client...`);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // DM 场景下 Channel 往往需要 partial，避免事件被吞掉或对象不完整
      partials: [Partials.Channel],
    });

    this.setupListeners();
    console.log(`[Discord:${channelId}] Logging in with token...`);
    this.client.login(token).catch((err) => {
      console.error(`[Discord:${channelId}] Login failed:`, err);
    });
  }

  private setupListeners() {
    this.client.on(Events.ClientReady, (readyClient) => {
      this.isConnected = true;
      console.log(`[Discord:${this.channelId}] ✓ Connected as ${readyClient.user.tag} (${readyClient.user.id})`);
      console.log(`[Discord:${this.channelId}] Guilds: ${readyClient.guilds.cache.size}`);
      if (readyClient.guilds.cache.size > 0) {
        console.log(`[Discord:${this.channelId}] Guild names: ${readyClient.guilds.cache.map((g) => g.name).join(", ")}`);
      }

      const intents = Array.isArray(this.client.options.intents)
        ? this.client.options.intents.join(",")
        : this.client.options.intents.toArray().join(",");
      const partials = (this.client.options.partials ?? []).join(",") || "none";
      console.log(`[Discord:${this.channelId}] Client options: intents=${intents}, partials=${partials}`);
      console.log(`[Discord:${this.channelId}] DM debugging enabled. Waiting for MessageCreate events...`);
    });

    this.client.on(Events.Debug, (message) => {
      if (process.env.DEBUG_MODE === "true") {
        console.log(`[Discord:${this.channelId}] Debug: ${message}`);
      }
    });

    this.client.on(Events.Warn, (message) => {
      console.warn(`[Discord:${this.channelId}] Warn: ${message}`);
    });

    this.client.on(Events.Error, (error) => {
      console.error(`[Discord:${this.channelId}] Error:`, error);
    });

    this.client.on("disconnect", () => {
      this.isConnected = false;
      console.warn(`[Discord:${this.channelId}] Disconnected from Discord`);
    });

    this.client.on("reconnecting", () => {
      console.log(`[Discord:${this.channelId}] Reconnecting to Discord...`);
    });

    this.client.on(Events.ShardReady, (shardId) => {
      console.log(`[Discord:${this.channelId}] Shard ready: ${shardId}`);
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      console.log(`[Discord:${this.channelId}] Shard resumed: ${shardId}, replayedEvents=${replayedEvents}`);
    });

    this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
      console.warn(
        `[Discord:${this.channelId}] Shard disconnected: shard=${shardId}, code=${closeEvent.code}, reason=${closeEvent.reason || "unknown"}`,
      );
    });

    this.client.on(Events.ThreadCreate, async (thread) => {
      try {
        const meta = await buildThreadConversationMeta(thread);
        console.log(`[Discord:${this.channelId}] ThreadCreate observed`, {
          threadId: thread.id,
          parentId: meta.parentId,
          starterMessageId: meta.starterMessageId,
          name: meta.threadName,
        });

        await publishConversationCreateEvent({
          channelId: this.channelId,
          provider: "discord",
          externalChatId: thread.id,
          externalMessageId: meta.starterMessageId ?? `thread:${thread.id}`,
          bindingKey: `discord:conversation:${thread.id}`,
          conversation: {
            id: thread.id,
            parentId: meta.parentId,
            meta: {
              isThread: true,
              isDm: false,
              threadName: meta.threadName,
              channelName: meta.threadName,
              parentChannelName: "parent" in thread && thread.parent && "name" in thread.parent ? thread.parent.name ?? null : null,
              guildName: thread.guild?.name ?? null,
              archived: meta.archived,
              locked: meta.locked,
              autoArchiveDuration: meta.autoArchiveDuration,
            },
          },
          message: {
            parentMessageId: meta.starterMessageId,
            meta: {
              source: "thread_create",
            },
          },
          meta: {
            isThread: true,
            threadCreate: true,
            threadName: meta.threadName,
            channelName: meta.threadName,
            parentChannelName: "parent" in thread && thread.parent && "name" in thread.parent ? thread.parent.name ?? null : null,
            guildName: thread.guild?.name ?? null,
            parentId: meta.parentId,
          },
        });
      } catch (error) {
        console.error(`[Discord:${this.channelId}] Failed to inspect thread create:`, error);
      }
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      const channelType = `${message.channel?.type ?? "unknown"}`;
      const isDM = message.channel?.isDMBased?.() ?? false;
      const isThread = message.channel?.isThread?.() ?? false;
      const parentConversationId = isThread && "parentId" in message.channel ? (message.channel.parentId ?? null) : null;
      let parentMessageId = message.reference?.messageId ?? null;

      if (isThread && !parentMessageId && "fetchStarterMessage" in message.channel) {
        const starter = await (message.channel as AnyThreadChannel & { fetchStarterMessage?: () => Promise<Message | null> })
          .fetchStarterMessage?.()
          .catch(() => null);
        parentMessageId = starter?.id ?? null;
      }

      console.log(`[Discord:${this.channelId}] MessageCreate event observed:`, {
        messageId: message.id,
        authorId: message.author?.id,
        authorTag: message.author?.tag,
        authorBot: message.author?.bot,
        channelId: message.channelId,
        channelType,
        guildId: message.guildId || "DM",
        isDM,
        isThread,
        partial: message.partial,
        contentLength: message.content?.length ?? 0,
        attachments: message.attachments.size,
      });

      if (message.author.bot) {
        console.log(`[Discord:${this.channelId}] Ignoring bot-authored message ${message.id}`);
        return;
      }

      const accepted = await shouldAcceptDiscordInboundMessage(this.channelId, message);
      if (!accepted) {
        console.log(`[Discord:${this.channelId}] Ignoring message ${message.id}: mention required by inbound config`);
        return;
      }

      console.log(`[Discord:${this.channelId}] ← Message received:`, {
        author: `${message.author.tag} (${message.author.id})`,
        channelId: message.channelId,
        guildId: message.guildId || "DM",
        channelType,
        bindingKey: buildDiscordBindingKey(message),
        content: message.content.slice(0, 100) + (message.content.length > 100 ? "..." : ""),
        attachments: message.attachments.size,
      });

      const cleanedContent = resolveMentions(message);
      const content: ContentBlock[] = [{ type: "text", text: cleanedContent }];

      for (const attachment of message.attachments.values()) {
        if (attachment.contentType?.startsWith("image/")) {
          content.push({ type: "image", source: { type: "url", url: attachment.url } });
          console.log(`[Discord:${this.channelId}] Attachment: ${attachment.name} (${attachment.contentType})`);
        } else {
          console.log(
            `[Discord:${this.channelId}] Non-image attachment ignored: ${attachment.name || "unnamed"} (${attachment.contentType || "unknown"})`,
          );
        }
      }

      const inboundEvent: GatewayInboundEvent = {
        eventId: randomUUID(),
        timestamp: Date.now(),
        channelId: this.channelId,
        provider: "discord",
        externalChatId: message.channelId,
        externalMessageId: message.id,
        bindingKey: buildDiscordBindingKey(message),
        conversation: {
          id: message.channelId,
          parentId: parentConversationId,
          meta: {
            guildId: message.guildId ?? null,
            channelType,
            isDm: isDM,
            isThread,
            threadName: "name" in message.channel ? message.channel.name ?? null : null,
            channelName: "name" in message.channel ? message.channel.name ?? null : null,
            parentChannelName:
              isThread && "parent" in message.channel && message.channel.parent && "name" in message.channel.parent
                ? message.channel.parent.name ?? null
                : null,
            guildName: message.guild?.name ?? null,
          },
        },
        message: {
          parentMessageId,
          meta: {
            discordMessageType: message.type,
            reference: message.reference
              ? {
                  messageId: message.reference.messageId ?? null,
                  channelId: message.reference.channelId ?? null,
                  guildId: message.reference.guildId ?? null,
                }
              : null,
            attachments: message.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              contentType: attachment.contentType,
              size: attachment.size,
              url: attachment.url,
            })),
          },
        },
        sender: {
          id: message.author.id,
          name: message.author.username,
        },
        content,
        meta: {
          guildId: message.guildId ?? null,
          channelId: message.channelId,
          channelType,
          isDm: isDM,
          isThread,
          threadParentId: parentConversationId,
          channelName: "name" in message.channel ? message.channel.name ?? null : null,
          parentChannelName:
            isThread && "parent" in message.channel && message.channel.parent && "name" in message.channel.parent
              ? message.channel.parent.name ?? null
              : null,
          guildName: message.guild?.name ?? null,
        },
      };

      console.log(`[Discord:${this.channelId}] → Publishing inbound event ${inboundEvent.eventId.slice(0, 8)}`, {
        externalChatId: inboundEvent.externalChatId,
        externalMessageId: inboundEvent.externalMessageId,
        bindingKey: inboundEvent.bindingKey,
        blockTypes: inboundEvent.content.map((block) => block.type).join(","),
      });
      await publishInboundEvent(inboundEvent);
      console.log(`[Discord:${this.channelId}] ✓ Inbound event published ${inboundEvent.eventId.slice(0, 8)}`);
    });
  }

  public async handleOutbound(cmd: GatewayOutboundCommand) {
    console.log(`[Discord:${this.channelId}] → Sending message to ${cmd.externalChatId}:`, {
      contentPreview: cmd.content.map((c) => (c.type === "text" ? c.text?.slice(0, 30) : c.type)).join(", "),
      replyTo: cmd.replyToExternalMessageId?.slice(0, 8) || "none",
      sessionMessageId: cmd.sessionMessageId ?? "none",
    });

    try {
      const channel = await this.client.channels.fetch(cmd.externalChatId);
      if (!channel) {
        console.error(`[Discord:${this.channelId}] Channel not found: ${cmd.externalChatId}`);
        return { success: false as const, error: `Channel not found: ${cmd.externalChatId}` };
      }
      if (!channel.isTextBased()) {
        console.error(`[Discord:${this.channelId}] Channel is not text-based: ${cmd.externalChatId}`);
        return { success: false as const, error: `Channel is not text-based: ${cmd.externalChatId}` };
      }

      const { text, imageUris } = await buildDiscordOutboundPayload(this.channelId, cmd);
      const files = imageUris;
      const textChannel = channel as TextBasedChannel;
      const renderMode = String(cmd.meta?.renderMode ?? "message");
      const hasRenderableContent = Boolean(text.trim()) || files.length > 0;

      if (renderMode === "rich_status" && !hasRenderableContent) {
        console.log(`[Discord:${this.channelId}] Skipping empty rich_status update`, {
          commandId: cmd.commandId,
          sessionMessageId: cmd.sessionMessageId ?? "none",
        });
        return { success: true as const };
      }

      const turnAnchorMessageId = typeof cmd.meta?.turnAnchorMessageId === "string"
        ? cmd.meta.turnAnchorMessageId.trim()
        : "";
      const cachedTurnMessageId = turnAnchorMessageId
        ? await getTurnMessageExternalRef(this.channelId, turnAnchorMessageId).catch(() => null)
        : null;
      const editTargetMessageId = typeof cmd.meta?.editExternalMessageId === "string" && cmd.meta.editExternalMessageId.trim().length > 0
        ? cmd.meta.editExternalMessageId
        : (cachedTurnMessageId ?? undefined);

      const isPrimaryDisplay = renderMode === "rich_status"
        || cmd.meta?.source === "session_persist"
        || cmd.meta?.source === "session_persist_broadcast";
      const isFinalAssistant = cmd.meta?.source === "session_persist" && cmd.meta?.sessionMessageRole === "assistant";
      const messageChunks = isFinalAssistant
        ? splitDiscordMessage(text, 1900)
        : [truncate(text || "", 1900)].filter((item) => item.trim().length > 0);
      const primaryContent = messageChunks[0] ?? "";

      if (!primaryContent && files.length === 0) {
        console.log(`[Discord:${this.channelId}] Skipping empty outbound message`, {
          commandId: cmd.commandId,
          renderMode,
          source: typeof cmd.meta?.source === "string" ? cmd.meta.source : "unknown",
          sessionMessageId: cmd.sessionMessageId ?? "none",
        });
        return { success: true as const };
      }

      if (editTargetMessageId && "messages" in textChannel && primaryContent) {
        const target = await textChannel.messages.fetch(editTargetMessageId).catch(() => null);
        if (target) {
          await target.edit({ content: primaryContent });
          if (turnAnchorMessageId) {
            await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, target.id).catch(console.error);
          }

          if (isFinalAssistant) {
            let previousMessageId = target.id;
            for (const chunk of messageChunks.slice(1)) {
              const continuationOptions: MessageCreateOptions = {
                content: chunk,
                files: [],
                reply: { messageReference: previousMessageId },
              };
              const continuation = (await (textChannel as Extract<typeof textChannel, { send: (options: MessageCreateOptions) => Promise<unknown> }>).send(continuationOptions)) as { id: string };
              previousMessageId = continuation.id;
            }
          }

          console.log(`[Discord:${this.channelId}] ✓ Message edited successfully: ${target.id}`);
          return { success: true as const, externalMessageId: target.id };
        }
      }

      if (!("send" in textChannel)) {
        console.error(`[Discord:${this.channelId}] Channel ${cmd.externalChatId} does not support sending messages`);
        return { success: false as const, error: "Channel does not support sending messages" };
      }

      const messageOptions: MessageCreateOptions = { content: primaryContent, files };
      if (cmd.replyToExternalMessageId) {
        messageOptions.reply = { messageReference: cmd.replyToExternalMessageId };
      }

      const sendableChannel = textChannel as Extract<typeof textChannel, { send: (options: MessageCreateOptions) => Promise<unknown> }>;
      const sentMsg = (await sendableChannel.send(messageOptions)) as { id: string };
      if (turnAnchorMessageId) {
        await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, sentMsg.id).catch(console.error);
      }

      let previousMessageId = sentMsg.id;
      for (const chunk of messageChunks.slice(1)) {
        const continuationOptions: MessageCreateOptions = {
          content: chunk,
          files: [],
          reply: { messageReference: previousMessageId },
        };
        const continuation = (await sendableChannel.send(continuationOptions)) as { id: string };
        previousMessageId = continuation.id;
      }

      console.log(`[Discord:${this.channelId}] ✓ Message sent successfully: ${sentMsg.id}`);
      return { success: true as const, externalMessageId: sentMsg.id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Discord:${this.channelId}] ✗ Failed to send message:`, errorMessage);
      if (error instanceof Error && error.stack) {
        console.error(`[Discord:${this.channelId}] Stack trace:`, error.stack.split("\n").slice(0, 3).join("\n"));
      }
      return { success: false as const, error: errorMessage };
    }
  }

  public destroy() {
    console.log(`[Discord:${this.channelId}] Destroying Discord client...`);
    this.client.destroy();
    this.isConnected = false;
    console.log(`[Discord:${this.channelId}] Discord client destroyed`);
  }
}
