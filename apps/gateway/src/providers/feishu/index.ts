import * as Lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import type { GatewayInboundEvent, GatewayOutboundCommand, ContentBlock, FeishuChannelConfig } from "@cohub/protocol";
import type { GatewayProvider } from "../base.js";
import { publishInboundEvent, publishConversationCreateEvent } from "../../bus.js";
import { getSpaceChannelConfig, getTurnMessageExternalRef, setTurnMessageExternalRef } from "../../redis.js";
import {
  detectIdType,
  resolveReceiveIdType,
  buildFeishuBindingKey,
  resolveAtMentions,
} from "./utils.js";

// Provider-level dedup for WS reconnect duplicate delivery
const messageDedup = new Map<string, number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 10000;

function dedupAndPurge(eventId: string): boolean {
  if (messageDedup.has(eventId)) return false;
  messageDedup.set(eventId, Date.now());
  if (messageDedup.size > DEDUP_MAX_ENTRIES) {
    const now = Date.now();
    for (const [id, ts] of messageDedup) {
      if (now - ts > DEDUP_TTL_MS) messageDedup.delete(id);
    }
  }
  return true;
}

export class FeishuProvider implements GatewayProvider {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private dispatcher: Lark.EventDispatcher;
  private channelId: string;
  private appId: string;
  private botOpenId?: string;

  constructor(
    channelId: string,
    credentials: { appId: string; appSecret: string; brand?: "feishu" | "lark" },
  ) {
    this.channelId = channelId;
    this.appId = credentials.appId;
    const domain = credentials.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

    console.log(`[Feishu:${channelId}] Creating Feishu client (domain=${domain})`);

    this.client = new Lark.Client({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });

    this.dispatcher = new Lark.EventDispatcher({
      encryptKey: "",
      verificationToken: "",
    });

    this.wsClient = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.setupListeners();

    console.log(`[Feishu:${channelId}] Starting WebSocket connection...`);
    this.wsClient.start({ eventDispatcher: this.dispatcher }).catch((err) => {
      console.error(`[Feishu:${channelId}] WS start failed:`, err);
    });

    // Probe bot identity
    this.probeBot();
  }

  private async probeBot() {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Lark SDK request method is not publicly typed
      const res = await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      if (res.code === 0 && res.data?.bot?.open_id) {
        this.botOpenId = res.data.bot.open_id;
        console.log(`[Feishu:${this.channelId}] ✓ Bot open_id: ${this.botOpenId}`);
      } else {
        console.warn(`[Feishu:${this.channelId}] Probe bot returned no open_id:`, JSON.stringify(res).slice(0, 200));
      }
    } catch (err) {
      console.error(`[Feishu:${this.channelId}] Probe bot failed:`, err);
    }
  }

  private setupListeners() {
    this.dispatcher.register({
      "im.message.receive_v1": (data: unknown) => {
        this.handleMessageEvent(data).catch((err) => {
          console.error(`[Feishu:${this.channelId}] Handle message error:`, err);
        });
      },
    });
  }

  private async handleMessageEvent(data: unknown) {
    const event = data as {
      event_id?: string;
      app_id?: string;
      sender?: { sender_id: { open_id?: string; user_id?: string } };
      message?: {
        message_id: string;
        chat_id: string;
        chat_type: "p2p" | "group";
        message_type: string;
        content: string;
        thread_id?: string;
        root_id?: string;
        parent_id?: string;
        create_time?: string;
        mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
      };
    };

    const eventId = event.event_id;
    if (!eventId) return;

    // App ownership check
    if (event.app_id && event.app_id !== this.appId) {
      return;
    }

    // Dedup
    if (!dedupAndPurge(eventId)) {
      console.log(`[Feishu:${this.channelId}] Duplicate event ${eventId.slice(0, 8)}, skipping`);
      return;
    }

    const msg = event.message;
    if (!msg) return;

    // Expired message filter (5 min)
    if (msg.create_time) {
      const age = Date.now() - Number.parseInt(msg.create_time, 10) * 1000;
      if (age > 5 * 60 * 1000) {
        console.log(`[Feishu:${this.channelId}] Expired message ${msg.message_id}, skipping`);
        return;
      }
    }

    const isDm = msg.chat_type === "p2p";

    // Group: skip if bot not mentioned (config-controlled)
    if (!isDm) {
      const config = await getSpaceChannelConfig<FeishuChannelConfig>(this.channelId);
      const requireMention = config?.inbound?.requireMentionInGroup ?? true;
      if (requireMention && this.botOpenId) {
        const hasMention = msg.mentions?.some((m) => m.id.open_id === this.botOpenId) ?? false;
        if (!hasMention) {
          console.log(`[Feishu:${this.channelId}] Bot not mentioned in group ${msg.chat_id}, skipping`);
          return;
        }
      }
    }

    // Parse message content
    const contentBlocks = this.parseMessageContent(msg);

    const threadId = msg.thread_id || msg.root_id || null;
    const parentMessageId = msg.root_id || msg.parent_id || null;
    const bindingKey = buildFeishuBindingKey(msg.chat_id, threadId);

    const inboundEvent: GatewayInboundEvent = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      channelId: this.channelId,
      provider: "feishu",
      externalChatId: msg.chat_id,
      externalMessageId: msg.message_id,
      bindingKey,
      conversation: {
        id: msg.chat_id,
        parentId: threadId ?? undefined,
        meta: {
          chatType: msg.chat_type,
          isDm,
          threadId,
        },
      },
      message: {
        parentMessageId: parentMessageId ?? undefined,
        meta: {
          threadId,
          messageType: msg.message_type,
        },
      },
      sender: {
        id: event.sender?.sender_id?.open_id ?? "",
        name: "", // Enriched later if needed
      },
      content: contentBlocks,
      meta: {
        chatType: msg.chat_type,
        isDm,
        threadId,
        mentions: msg.mentions?.map((m) => ({ key: m.key, openId: m.id.open_id, name: m.name })) ?? null,
      },
    };

    console.log(
      `[Feishu:${this.channelId}] → Inbound: ${inboundEvent.externalMessageId.slice(0, 8)} chat=${msg.chat_id} type=${msg.chat_type}${threadId ? ` thread=${threadId}` : ""}`,
    );
    await publishInboundEvent(inboundEvent);
  }

  private parseMessageContent(msg: {
    message_type: string;
    content: string;
    mentions?: Array<{ id: { open_id?: string }; name: string }>;
  }): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (msg.message_type === "text") {
      const text = resolveAtMentions(msg.content);
      if (text.trim()) blocks.push({ type: "text", text });
    } else if (msg.message_type === "post") {
      try {
        const parsed = JSON.parse(msg.content);
        const locale = parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0] as Record<string, unknown>;
        const parts: string[] = [];
        for (const row of ((locale?.content as unknown[] | undefined) ?? [])) {
          for (const item of (row as Array<Record<string, string>> | undefined) ?? []) {
            if (item.tag === "text" || item.tag === "md") {
              parts.push(item.text ?? "");
            } else if (item.tag === "a") {
              parts.push(item.text ?? item.href ?? "[link]");
            } else if (item.tag === "img") {
              parts.push(`[image:${item.image_key ?? "unknown"}]`);
            } else if (item.tag === "media") {
              parts.push(`[media:${item.file_key ?? "unknown"}]`);
            } else if (item.tag === "file") {
              parts.push(`[file:${item.file_key ?? "unknown"}]`);
            }
          }
        }
        const text = resolveAtMentions(parts.join("\n"));
        if (text.trim()) blocks.push({ type: "text", text });
      } catch {
        blocks.push({ type: "text", text: msg.content });
      }
    } else if (msg.message_type === "image") {
      try {
        const parsed = JSON.parse(msg.content);
        blocks.push({ type: "text", text: `[image: ${parsed.image_key ?? "unknown"}]` });
      } catch {
        blocks.push({ type: "text", text: "[image]" });
      }
    } else if (msg.message_type === "file") {
      try {
        const parsed = JSON.parse(msg.content);
        blocks.push({ type: "text", text: `[file: ${parsed.file_name ?? parsed.file_key ?? "unknown"}]` });
      } catch {
        blocks.push({ type: "text", text: "[file]" });
      }
    } else {
      blocks.push({ type: "text", text: `[${msg.message_type} message]` });
    }

    return blocks;
  }

  public async handleOutbound(cmd: GatewayOutboundCommand): Promise<{ success: boolean; error?: string; externalMessageId?: string }> {
    console.log(`[Feishu:${this.channelId}] → Outbound to ${cmd.externalChatId}`, {
      contentPreview: cmd.content.map((c) => (c.type === "text" ? c.text?.slice(0, 30) : c.type)).join(", "),
      replyTo: cmd.replyToExternalMessageId?.slice(0, 8) || "none",
      source: typeof cmd.meta?.source === "string" ? cmd.meta.source : "unknown",
    });

    try {
      const config = await getSpaceChannelConfig<FeishuChannelConfig>(this.channelId);
      const isFinalMessage = cmd.meta?.source === "session_persist";
      // Per-command renderMode override; falls back to channel config, then default "post"
      const renderMode = (cmd.meta?.renderMode ?? config?.outbound?.renderMode ?? "post") as "card" | "post";

      let msgType: string;
      let content: string;
      let imageKeys: string[] = [];

      if (renderMode === "card") {
        msgType = "interactive";
        const card = this.buildCard(cmd, {
          isFinal: isFinalMessage,
          showThinking: config?.outbound?.showThinking ?? false,
          showToolCalls: config?.outbound?.showToolCalls ?? false,
        });
        content = JSON.stringify(card);
        imageKeys = this.extractImageKeys(cmd.content);
      } else {
        msgType = "post";
        const text = this.buildPostText(cmd, {
          isFinal: isFinalMessage,
          showThinking: config?.outbound?.showThinking ?? false,
          showToolCalls: config?.outbound?.showToolCalls ?? false,
        });
        if (!text.trim()) {
          console.log(`[Feishu:${this.channelId}] Skipping empty outbound message`);
          return { success: true };
        }
        content = JSON.stringify({
          zh_cn: {
            content: [[{ tag: "md", text }]],
          },
        });
      }

      // Determine if we should edit/update an existing message
      const editExternalMessageId = (cmd.meta?.editExternalMessageId as string)?.trim();
      const turnAnchorMessageId = (cmd.meta?.turnAnchorMessageId as string)?.trim();
      const cachedMessageId = turnAnchorMessageId
        ? await getTurnMessageExternalRef(this.channelId, turnAnchorMessageId).catch(() => null)
        : null;
      const targetMessageId = editExternalMessageId || cachedMessageId;

      // --- Update path: patch card or update post ---
      if (targetMessageId) {
        if (renderMode === "card") {
          await this.client.im.message.patch({
            path: { message_id: targetMessageId },
            data: { content },
          });
          console.log(`[Feishu:${this.channelId}] ✓ Card patched: ${targetMessageId}`);
          return { success: true, externalMessageId: targetMessageId };
        }
        // Post mode: update existing message
        await this.client.im.message.update({
          path: { message_id: targetMessageId },
          data: { content, msg_type: "post" },
        });
        console.log(`[Feishu:${this.channelId}] ✓ Post updated: ${targetMessageId}`);
        return { success: true, externalMessageId: targetMessageId };
      }

      // --- Create new message ---
      const receiveIdType = resolveReceiveIdType(cmd.externalChatId);

      // Reply path
      if (cmd.replyToExternalMessageId) {
        const threadId = cmd.meta?.threadId as string | undefined;
        const replyResult = await this.client.im.message.reply({
          path: { message_id: cmd.replyToExternalMessageId },
          data: {
            content,
            msg_type: msgType,
            reply_in_thread: !!threadId,
          },
        });
        const messageId = replyResult?.data?.message_id;
        if (turnAnchorMessageId && messageId) {
          await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, messageId).catch(() => {});
        }
        console.log(`[Feishu:${this.channelId}] ✓ Reply sent: ${messageId}`);
        return { success: true, externalMessageId: messageId };
      }

      // Create path
      const createResult = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" },
        data: {
          receive_id: cmd.externalChatId,
          msg_type: msgType,
          content,
        },
      });
      const messageId = createResult?.data?.message_id;
      if (turnAnchorMessageId && messageId) {
        await setTurnMessageExternalRef(this.channelId, turnAnchorMessageId, messageId).catch(() => {});
      }

      // Send images as separate messages after the card/text (Feishu doesn't support inline images)
      if (imageKeys.length > 0 && messageId) {
        for (const imgKey of imageKeys) {
          try {
            await this.client.im.message.create({
              params: { receive_id_type: receiveIdType as "chat_id" | "open_id" | "user_id" },
              data: {
                receive_id: cmd.externalChatId,
                msg_type: "image",
                content: JSON.stringify({ image_key: imgKey }),
              },
            });
          } catch {
            console.log(`[Feishu:${this.channelId}] Failed to send image ${imgKey}`);
          }
        }
      }

      console.log(`[Feishu:${this.channelId}] ✓ Message created: ${messageId}`);
      return { success: true, externalMessageId: messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Feishu:${this.channelId}] ✗ Outbound failed:`, msg);
      if (err instanceof Error && err.stack) {
        console.error(`[Feishu:${this.channelId}] Stack:`, err.stack.split("\n").slice(0, 3).join("\n"));
      }
      return { success: false, error: msg };
    }
  }

  private buildCard(
    cmd: GatewayOutboundCommand,
    opts: {
      isFinal: boolean;
      showThinking: boolean;
      showToolCalls: boolean;
    },
  ): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [];
    const thinking = !opts.isFinal && opts.showThinking && typeof cmd.meta?.thinking === "string" ? cmd.meta.thinking : "";
    const toolCalls = opts.showToolCalls && !opts.isFinal && Array.isArray(cmd.meta?.toolCalls)
      ? (cmd.meta.toolCalls as Array<Record<string, unknown>>)
      : [];
    const answer = typeof cmd.meta?.answer === "string" ? cmd.meta.answer : this.extractText(cmd.content);

    if (thinking.trim()) {
      elements.push({ tag: "markdown", content: `> ${thinking.trim()}` });
    }

    if (toolCalls.length > 0) {
      const lines = toolCalls
        .map((t) => this.buildToolLine(
          typeof t.status === "string" ? t.status : undefined,
          typeof t.toolName === "string" ? t.toolName : undefined,
          typeof t.summary === "string" ? t.summary : undefined,
        ))
        .join("\n");
      elements.push({ tag: "markdown", content: lines });
    }

    if (answer.trim()) {
      elements.push({ tag: "markdown", content: answer.trim() });
    }

    if (!opts.isFinal) {
      elements.push({ tag: "markdown", content: "🍳 cooking…" });
    }

    return {
      schema: "2.0",
      config: { wide_screen_mode: true, update_multi: true },
      body: { elements },
    };
  }

  private buildPostText(
    cmd: GatewayOutboundCommand,
    opts: {
      isFinal: boolean;
      showThinking: boolean;
      showToolCalls: boolean;
    },
  ): string {
    const parts: string[] = [];
    const thinking = !opts.isFinal && opts.showThinking && typeof cmd.meta?.thinking === "string" ? cmd.meta.thinking : "";
    const toolCalls = opts.showToolCalls && !opts.isFinal && Array.isArray(cmd.meta?.toolCalls)
      ? (cmd.meta.toolCalls as Array<Record<string, unknown>>)
      : [];
    const answer = typeof cmd.meta?.answer === "string" ? cmd.meta.answer : this.extractText(cmd.content);

    if (thinking.trim()) {
      parts.push(`> ${thinking.trim()}`);
    }

    if (toolCalls.length > 0) {
      const lines = toolCalls
        .map((t) => this.buildToolLine(
          typeof t.status === "string" ? t.status : undefined,
          typeof t.toolName === "string" ? t.toolName : undefined,
          typeof t.summary === "string" ? t.summary : undefined,
        ))
        .join("\n");
      parts.push(lines);
    }

    if (answer.trim()) {
      parts.push(answer.trim());
    }

    if (!opts.isFinal) {
      parts.push("🍳 cooking…");
    }

    return parts.join("\n").trim();
  }

  private buildToolLine(status: string | undefined, toolName: string | undefined, summary: string | undefined): string {
    const safeStatus = status ?? "queued";
    const safeToolName = toolName ?? "tool";
    const suffix = summary?.trim() ? ` ${summary.trim()}` : "";
    return `[${safeStatus}] ${safeToolName}${suffix}`;
  }

  private extractText(content: ContentBlock[]): string {
    return content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
  }

  private extractImageKeys(content: ContentBlock[]): string[] {
    const keys: string[] = [];
    for (const block of content) {
      if (block.type === "image" && block.source.type === "url") {
        // Extract image_key from Feishu image URL if present
        const url = block.source.url;
        const match = url.match(/img_v3_([a-zA-Z0-9_-]+)/);
        if (match) keys.push(match[0]);
      } else if (block.type === "text") {
        // Check for image_key placeholders in text (e.g. [image:img_v3_xxx])
        const imgPattern = /\[image:(img_v3_[a-zA-Z0-9_-]+)\]/g;
        const matches = block.text.match(imgPattern);
        if (matches) {
          for (const match of matches) {
            const key = match.slice(8, -1); // strip "[image:" and "]"
            if (key) keys.push(key);
          }
        }
      }
    }
    return keys;
  }

  public destroy() {
    console.log(`[Feishu:${this.channelId}] Destroying Feishu client...`);
    try {
      this.wsClient.close({ force: true });
    } catch {
      // Ignore errors during close
    }
    console.log(`[Feishu:${this.channelId}] Feishu client destroyed`);
  }
}
