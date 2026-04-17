# Schema V2 升级与数据迁移方案

本方案采用 **PostgreSQL Schema 隔离策略**。我们将所有的全新设计放在一个新的 PG Schema（如 `v2`）中，从而避免对现有的 `public` schema 中的旧表进行复杂的 `ALTER TABLE` 操作。系统跑通后，通过脚本将历史数据迁移至新 Schema。

## 1. 核心设计原则
- **极致精简**：Space 不再关心底层的运行状态（hibernated等），这些属于基础设施层的临时状态，不入主库；移除 `defaultBranch`，约定优于配置（如全量使用 `main`）；移除 `visibility`，统一交由 `resourcePermissions` 表管控。
- **动静分离**：Space 作为纯粹的容器上下文，Checkpoint 作为纯粹的快照节点（仅需 description 即可）。
- **命名空间隔离**：使用 Drizzle 的 `pgSchema('v2')`。
- **底层映射**：Checkpoint 对应 Git Commit；Proposal 发起时，基于该 Commit 动态创建 Git Branch 来满足 Gitea 的 PR 限制。

---

## 2. Drizzle Schema V2 定义 (完整版)

```typescript
import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  integer,
  numeric,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ContentBlock, TaskPayload } from "@cohub/protocol";

// 创建独立的 PostgreSQL Schema 命名空间
export const v2 = pgSchema("v2");

// ─── 核心动静分离模型 ───

export const spaces = v2.table(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    giteaRepoName: varchar("gitea_repo_name", { length: 255 }).notNull(),
    baseCheckpointId: uuid("base_checkpoint_id"), // 溯源
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("idx_spaces_user_uuid").on(table.userUuid),
    baseCheckpointIdx: index("idx_spaces_base_checkpoint_id").on(table.baseCheckpointId),
    userSpaceNameUniqueIdx: uniqueIndex("uq_spaces_user_name").on(table.userUuid, table.name),
    userSpaceRepoNameUniqueIdx: uniqueIndex("uq_spaces_user_repo_name").on(table.userUuid, table.giteaRepoName),
  })
);

export const checkpoints = v2.table(
  "checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    commitHash: varchar("commit_hash", { length: 40 }).notNull(),
    description: text("description").notNull(),
    parentCheckpointId: uuid("parent_checkpoint_id"),
    forkCount: integer("fork_count").notNull().default(0),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("idx_checkpoints_space_id").on(table.spaceId),
    parentIdx: index("idx_checkpoints_parent_id").on(table.parentCheckpointId),
    spaceCommitUniqueIdx: uniqueIndex("uq_checkpoints_space_commit").on(table.spaceId, table.commitHash),
  })
);

export const proposals = v2.table(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    sourceCheckpointId: uuid("source_checkpoint_id").notNull(),
    targetSpaceId: uuid("target_space_id").notNull(),
    externalPrId: varchar("external_pr_id", { length: 255 }),
    status: varchar("status", { length: 20 }).default("open"), 
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    targetSpaceIdx: index("idx_proposals_target_space_id").on(table.targetSpaceId),
    sourceCheckpointIdx: index("idx_proposals_source_checkpoint_id").on(table.sourceCheckpointId),
    statusIdx: index("idx_proposals_status").on(table.status),
  })
);

// ─── 会话与通道表 (由 Runtime 体系全面重命名并迁移至 Space 体系) ───

export const spaceChannels = v2.table(
  "space_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(), // 原 runtimeId
    channelId: uuid("channel_id").notNull(),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("idx_space_channels_space").on(table.spaceId),
    channelIdx: uniqueIndex("uq_space_channels_channel").on(table.channelId),
  })
);

export const spaceSessions = v2.table(
  "space_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(), // 原 runtimeId
    title: varchar("title", { length: 255 }),
    source: varchar("source", { length: 255 }),
    status: varchar("status", { length: 50 }).default("active"),
    cwd: text("cwd"),
    protocol: varchar("protocol", { length: 30 }),
    externalSessionId: text("external_session_id"),
    meta: jsonb("meta"),
    parentSessionId: uuid("parent_session_id"),
    forkedFromMessageId: uuid("forked_from_message_id"),
    lineageRootSessionId: uuid("lineage_root_session_id"),
    forkDepth: integer("fork_depth").notNull().default(0),
    latestMessageText: text("latest_message_text"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageId: uuid("last_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("idx_space_sessions_space_id").on(table.spaceId),
    parentIdx: index("idx_space_sessions_parent_id").on(table.parentSessionId),
  })
);

export const spaceSessionBindings = v2.table(
  "space_session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(), // 原 runtimeId
    spaceSessionId: uuid("space_session_id").notNull(), // 原 runtimeSessionId
    spaceChannelId: uuid("space_channel_id").notNull(), // 原 runtimeChannelId
    provider: varchar("provider", { length: 50 }).notNull(),
    bindingKey: varchar("binding_key", { length: 255 }).notNull(),
    externalChatId: varchar("external_chat_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("idx_space_session_bindings_space").on(table.spaceId),
    sessionIdx: index("idx_space_session_bindings_session").on(table.spaceSessionId),
    uniqueChannelBinding: uniqueIndex("uq_space_session_bindings_channel_binding").on(
      table.spaceChannelId,
      table.bindingKey,
    ),
  })
);

export const providerMessageRefs = v2.table(
  "provider_message_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 50 }).notNull(),
    spaceId: uuid("space_id").notNull(), // 原 runtimeId
    spaceSessionId: uuid("space_session_id").notNull(), // 原 runtimeSessionId
    spaceChannelId: uuid("space_channel_id"), // 原 runtimeChannelId
    sessionMessageId: uuid("session_message_id"),
    direction: varchar("direction", { length: 20 }).notNull(),
    externalConversationId: varchar("external_conversation_id", { length: 255 }).notNull(),
    externalMessageId: varchar("external_message_id", { length: 255 }).notNull(),
    parentExternalConversationId: varchar("parent_external_conversation_id", { length: 255 }),
    parentExternalMessageId: varchar("parent_external_message_id", { length: 255 }),
    externalAuthorId: varchar("external_author_id", { length: 255 }),
    externalAuthorName: varchar("external_author_name", { length: 255 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex("uq_provider_message_refs_message").on(
      table.provider,
      table.externalConversationId,
      table.externalMessageId,
      table.direction,
    ),
  })
);

export const sessionMessages = v2.table(
  "session_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(), // 现关联至 space_sessions.id
    role: varchar("role", { length: 20 }).notNull(),
    content: jsonb("content").notNull().$type<ContentBlock[]>(),
    text: text("text"),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    stopReason: varchar("stop_reason", { length: 50 }),
    errorMessage: text("error_message"),
    sequence: integer("sequence").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    usageInput: integer("usage_input"),
    usageOutput: integer("usage_output"),
    costTotal: numeric("cost_total", { precision: 18, scale: 8 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index("idx_session_messages_session_id").on(table.sessionId),
  })
);

// ─── 独立模块表与公共表 ───

// 用户账号/鉴权等无需改变实体概念的表，直接移入 v2 或保持 public。为保持完整性建议均迁移至 v2。
export const userGitAccounts = v2.table("user_git_accounts", { /* 结构完全不变 */ });
export const userChannels = v2.table("user_channels", { /* 结构完全不变 */ });
export const gatewayLogs = v2.table("gateway_logs", { /* 结构完全不变 */ });

// 权限表：原 resourceType 为 'workspace' 或 'agent'，迁移后将统一为 'space' 或 'checkpoint'
export const resourcePermissions = v2.table(
  "resource_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceType: varchar("resource_type", { length: 20 }).notNull(), // 'space', 'checkpoint' 等
    resourceId: uuid("resource_id").notNull(),
    granteeUuid: varchar("grantee_uuid", { length: 255 }),
    level: varchar("level", { length: 20 }).notNull().default("read"),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    resourceGrantUniqueIdx: uniqueIndex("uq_resource_permissions_grant").on(
      table.resourceType, table.resourceId, table.granteeUuid
    ),
  })
);

// 任务系统表：将冗余的 workspaceId / runtimeId 统一合并为 spaceId
export const cronJobs = v2.table(
  "cron_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    taskType: varchar("task_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
    timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Shanghai"),
    bullJobKey: varchar("bull_job_key", { length: 500 }).notNull(),
    
    // 合并为单一从属维度
    spaceId: uuid("space_id"), 
    sessionId: uuid("session_id"), // 关联至 spaceSessionId
    
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  }
);

export const taskRuns = v2.table(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: varchar("job_id", { length: 255 }).notNull(),
    cronJobId: uuid("cron_job_id"),
    taskType: varchar("task_type", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    payload: jsonb("payload").notNull().$type<TaskPayload>(),
    result: jsonb("result"),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    
    // 合并为单一从属维度
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    
    userUuid: varchar("user_uuid", { length: 255 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  }
);

---

## 3. Git 底层映射与协作设计
*(同上，Lazy Branch 策略设计，保持不变)*

## 4. 数据平滑迁移策略 (Migration Strategy)
在数据迁移脚本中，由于表字段的合并与重命名，需执行以下转换逻辑：
1. **Space 合并**：从 `public.workspaces` 映射至 `v2.spaces`。若需保留原运行时状态，可考虑将其合并入 meta 字段。
2. **Session 及关联记录重构**：读取 `public.runtime_sessions`，将其 `runtimeId` 替换为其关联的 `v2.spaces.id`（通过原 `workspaces.id` 与 `runtimes.workspaceId` 的映射关系计算），写入 `v2.space_sessions`。
3. **权限类型重命名**：迁移 `public.resource_permissions` 时，将 `resourceType` 从 `'workspace'` 或 `'agent'` 强制改写为 `'space'`。
4. **任务调度归一**：对于 `public.cron_jobs` 和 `public.task_runs`，将其上的 `workspaceId` 和 `runtimeId` 指针统一映射并赋值给 `v2` 表的 `spaceId`。