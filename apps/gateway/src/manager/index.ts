import os from "node:os";
import { redisCommandClient } from "../redis.js";
import { DiscordProvider } from "../providers/discord/index.js";
import { FeishuProvider } from "../providers/feishu/index.js";
import { WeChatProvider } from "../providers/wechat/index.js";
import { QQProvider } from "../providers/qq/index.js";
import type { GatewayProvider } from "../providers/base.js";
import { createLogger } from "@cohub/infra/logging";
import {
  markChannelConnecting,
  markChannelError,
  markChannelStopped,
} from "../channel-health.js";


const logger = createLogger({ serviceName: "cohub-gateway" });
const GATEWAY_NODE_TTL_MS = 15_000;

interface ChannelConfig {
  provider: string;
  credentials: Record<string, unknown>;
  spaceId?: string;
  externalChatId?: string;
}

type ProviderFactory = (channelId: string, credentials: Record<string, unknown>) => GatewayProvider;

// Register new providers here. Lifecycle health (connecting/start-error/stopped) is automatic.
// Connection ready/error should be reported inside the provider when detectable via channel-health helpers.
const providerFactories: Record<string, ProviderFactory> = {
  discord: (channelId, credentials) => new DiscordProvider(channelId, credentials.token as string),
  feishu: (channelId, credentials) => new FeishuProvider(channelId, {
    appId: credentials.appId as string,
    appSecret: credentials.appSecret as string,
    brand: (credentials.brand as "feishu" | "lark") ?? "feishu",
  }),
  wechat: (channelId, credentials) => new WeChatProvider(channelId, {
    token: credentials.token as string,
    accountId: credentials.accountId as string | undefined,
    userId: credentials.userId as string | undefined,
    baseUrl: credentials.baseUrl as string | undefined,
    cdnBaseUrl: credentials.cdnBaseUrl as string | undefined,
  }),
  qq: (channelId, credentials) => new QQProvider(channelId, {
    appId: credentials.appId as string,
    clientSecret: credentials.clientSecret as string,
    baseUrl: credentials.baseUrl as string | undefined,
    tokenBaseUrl: credentials.tokenBaseUrl as string | undefined,
  }),
};

type GatewayManagerOptions = {
  onStaleNodesPruned?: (nodeIds: string[]) => boolean | Promise<boolean>;
};

export class GatewayManager {
  public readonly nodeId: string;
  public started = false;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private syncInterval?: ReturnType<typeof setInterval>;
  private readonly onStaleNodesPruned?: GatewayManagerOptions["onStaleNodesPruned"];
  private syncInFlight = false;

  // 本地维持的实例集合 Map<ChannelId, ProviderInstance>
  private providers = new Map<string, GatewayProvider>();

  constructor(options: GatewayManagerOptions = {}) {
    // 优先使用 k8s 的 pod name (如 gateway-0)，回退到 hostname，再回退到随机生成的 id
    this.nodeId = process.env.POD_NAME || os.hostname() || `gw-${Math.random().toString(36).slice(2, 8)}`;
    this.onStaleNodesPruned = options.onStaleNodesPruned;
  }

  public async start() {
    logger.info(`[Manager] Starting Gateway Node: ${this.nodeId}`);

    // 1. 立即注册并开启心跳
    logger.info("[Manager] Sending initial heartbeat...");
    await this.registerNode();
    logger.info("[Manager] Initial heartbeat sent, starting heartbeat loop (interval: 5s)");
    this.heartbeatInterval = setInterval(() => this.registerNode(), 5000);

    // 2. 立即全量同步一次，并开启定时同步
    logger.info("[Manager] Performing initial task sync...");
    await this.syncTasks();
    logger.info("[Manager] Initial sync complete, starting sync loop (interval: 10s)");
    this.syncInterval = setInterval(() => this.syncTasks(), 10000);

    logger.info(`[Manager] Gateway Node ${this.nodeId} started successfully`);
    this.started = true;
  }

  public async stop() {
    logger.info(`[Manager] Stopping Gateway Node: ${this.nodeId}`);
    logger.info(`[Manager] Active providers to stop: ${this.providers.size}`);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      logger.info("[Manager] Heartbeat loop stopped");
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      logger.info("[Manager] Sync loop stopped");
    }

    // 清理本地所有的长连接
    for (const [channelId, provider] of this.providers.entries()) {
      try {
        logger.info(`[Manager] Destroying provider for ${channelId}...`);
        provider.destroy();
      } catch (err) {
        logger.error(`[Manager] Error destroying provider for ${channelId}:`, err);
      }
    }
    this.providers.clear();

    logger.info("[Manager] Leaving task assignments intact for stable restart handoff");

    logger.info(`[Manager] Node ${this.nodeId} stopped`);
  }

  private async registerNode() {
    try {
      const now = Date.now();
      const staleBefore = now - GATEWAY_NODE_TTL_MS;
      // 使用 ZSET 记录节点和它的最后心跳时间 (用于 API 剔除死节点)
      const staleNodeIds = await redisCommandClient.zrangebyscore("gateway:nodes", 0, staleBefore);
      await redisCommandClient
        .multi()
        .zadd("gateway:nodes", String(now), this.nodeId)
        .zremrangebyscore("gateway:nodes", 0, staleBefore)
        .exec();

      const prunedStaleNodeIds = staleNodeIds.filter((nodeId) => nodeId !== this.nodeId);
      if (prunedStaleNodeIds.length > 0) {
        logger.warn("[Manager] Pruned stale gateway nodes", { nodeIds: prunedStaleNodeIds });
        const reconciled = await this.onStaleNodesPruned?.(prunedStaleNodeIds);
        if (reconciled) {
          await redisCommandClient.del(...prunedStaleNodeIds.map((nodeId) => `gateway:node:${nodeId}:channels`));
        }
      }
    } catch (error) {
      logger.error("[Manager] Failed to send heartbeat:", error);
    }
  }

  private async syncTasks() {
    if (this.syncInFlight) {
      logger.debug("[Manager] Skipping overlapping task sync");
      return;
    }

    this.syncInFlight = true;
    try {
      const syncStart = Date.now();
      // 获取分配给本节点的专属任务
      // 数据结构: HASH gateway:node:<nodeId>:channels
      // Field: channelId, Value: JSON string of ChannelConfig
      const tasksStr = await redisCommandClient.hgetall(`gateway:node:${this.nodeId}:channels`);

      const expectedChannelIds = new Set(Object.keys(tasksStr));
      const currentChannelIds = new Set(this.providers.keys());

      // 1. 需要新增或更新的连接
      const toAdd = Array.from(expectedChannelIds).filter(id => !currentChannelIds.has(id));
      const toRemove = Array.from(currentChannelIds).filter(id => !expectedChannelIds.has(id));

      logger.debug("[Manager] Gateway task sync", {
        expected_count: expectedChannelIds.size,
        current_count: currentChannelIds.size,
        to_add_count: toAdd.length,
        to_remove_count: toRemove.length,
      });

      if (toAdd.length > 0) {
        logger.info(`[Manager] Channels to add: [${toAdd.join(", ")}]`);
      }
      if (toRemove.length > 0) {
        logger.info(`[Manager] Channels to remove: [${toRemove.join(", ")}]`);
      }

      for (const channelId of toAdd) {
        const configStr = tasksStr[channelId];
        if (configStr) {
          const config = JSON.parse(configStr);
          this.startProvider(channelId, config);
        }
      }
      // TODO: 如果配置变了(比如 token 变了)，可能需要重启 provider

      // 2. 需要断开的连接 (本地有，但 Redis 里没有了)
      for (const channelId of toRemove) {
        await this.stopProvider(channelId);
      }

      logger.debug("[Manager] Gateway task sync completed", {
        duration_ms: Date.now() - syncStart,
      });
    } catch (error) {
      logger.error("[Manager] Failed to sync tasks:", error);
    } finally {
      this.syncInFlight = false;
    }
  }

  private startProvider(channelId: string, config: ChannelConfig) {
    logger.info(`[Manager] Starting provider for channel ${channelId} (${config.provider})`);
    void markChannelConnecting(channelId, this.nodeId).catch((error) => {
      logger.warn("[Manager] failed to mark channel connecting", { channelId, error });
    });
    try {
      const factory = providerFactories[config.provider];
      if (!factory) {
        logger.warn(`[Manager] Unsupported provider: ${config.provider}`);
        void markChannelError(channelId, `Unsupported provider: ${config.provider}`, {
          nodeId: this.nodeId,
          reasonCode: "provider_error",
          message: "Unsupported provider",
        }).catch(() => undefined);
        return;
      }
      const provider = factory(channelId, config.credentials);
      this.providers.set(channelId, provider);
      logger.info(`[Manager] Provider for ${channelId} created and added to active providers`);
    } catch (error) {
      logger.error(`[Manager] Error starting provider for ${channelId}:`, error);
      void markChannelError(channelId, error, { nodeId: this.nodeId }).catch(() => undefined);
    }
  }

  private async stopProvider(channelId: string) {
    logger.info(`[Manager] Stopping provider for ${channelId}`);
    const provider = this.providers.get(channelId);
    if (provider) {
      try {
        provider.destroy();
        logger.info(`[Manager] Provider for ${channelId} destroyed`);
      } catch (error) {
        logger.error(`[Manager] Error destroying provider for ${channelId}:`, error);
      }
      this.providers.delete(channelId);
    }
    await markChannelStopped(channelId).catch((error) => {
      logger.warn("[Manager] failed to mark channel stopped", { channelId, error });
    });
  }

  // 供 index.ts 使用，当收到 API 的 outbound 消息时路由给具体的 provider
  public getProvider(channelId: string) {
    return this.providers.get(channelId);
  }

  // 获取当前活跃的 channel IDs (用于 debug)
  public getActiveChannelIds(): string[] {
    return Array.from(this.providers.keys());
  }
}
