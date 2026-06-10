import { sql } from "drizzle-orm";
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
  check,
  doublePrecision,
} from "drizzle-orm/pg-core";
import type { ContentBlock } from "@cohub/protocol/core";
import type { TaskPayload } from "@cohub/protocol/task";
import type {
  SessionTurnIntent,
  SessionTurnIntermediateIndex,
  SessionTurnIntermediateSummary,
  SessionTurnStatus,
  SessionTurnSummary,
} from "@cohub/protocol/model";

export type SpaceRole = "host" | "builder" | "guest";
export type AccessPolicyRole = "builder" | "guest" | null;
export type AccessPolicyResourceType = "space" | "session";
export type VoiceLexiconSource = "manual" | "auto" | "correction";

export const v2 = pgSchema("v2");

export const userProfiles = v2.table(
  "user_profiles",
  {
    userUuid: varchar("user_uuid", { length: 255 }).primaryKey(),
    logtoUserId: varchar("logto_user_id", { length: 255 }).notNull(),
    username: varchar("username", { length: 39 }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    avatarUrl: text("avatar_url"),
    source: jsonb("source").$type<Record<string, unknown>>().notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    logtoUserIdUniqueIdx: uniqueIndex("v2_uq_user_profiles_logto_user_id").on(
      table.logtoUserId,
    ),
    updatedAtIdx: index("v2_idx_user_profiles_updated_at").on(table.updatedAt),
    usernameUniqueIdx: uniqueIndex("v2_uq_user_profiles_username").on(table.username),
  }),
);

export const userVoiceLexiconEntries = v2.table(
  "user_voice_lexicon_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    term: text("term").notNull(),
    termKey: varchar("term_key", { length: 120 }).notNull(),
    source: varchar("source", { length: 20 }).$type<VoiceLexiconSource>().notNull().default("manual"),
    originalText: text("original_text"),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_user_voice_lexicon_user_uuid").on(table.userUuid),
    userTermUniqueIdx: uniqueIndex("v2_uq_user_voice_lexicon_user_term").on(
      table.userUuid,
      table.termKey,
    ),
  }),
);

export const userGitAccounts = v2.table(
  "user_git_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull().default("gitea"),
    giteaUserId: integer("gitea_user_id").notNull(),
    giteaUsername: varchar("gitea_username", { length: 255 }).notNull(),
    giteaPasswordEncrypted: text("gitea_password_encrypted").notNull(),
    giteaAccessTokenEncrypted: text("gitea_access_token_encrypted").notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidProviderUniqueIdx: uniqueIndex("v2_uq_user_git_accounts_user_provider").on(
      table.userUuid,
      table.provider,
    ),
    giteaUsernameUniqueIdx: uniqueIndex("v2_uq_user_git_accounts_gitea_username").on(
      table.giteaUsername,
    ),
    userUuidIdx: index("v2_idx_user_git_accounts_user_uuid").on(table.userUuid),
    providerIdx: index("v2_idx_user_git_accounts_provider").on(table.provider),
  }),
);

export const userChannels = v2.table(
  "user_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    name: varchar("name", { length: 255 }),
    credentials: jsonb("credentials").notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_user_channels_user_uuid").on(table.userUuid),
    providerIdx: index("v2_idx_user_channels_provider").on(table.provider),
  }),
);

export const spaces = v2.table(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 80 }),
    description: text("description"),
    storageRepoName: varchar("storage_repo_name", { length: 255 }).notNull(),
    baseCheckpointId: uuid("base_checkpoint_id"),
    headCheckpointId: uuid("head_checkpoint_id"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_spaces_user_uuid").on(table.userUuid),
    baseCheckpointIdx: index("v2_idx_spaces_base_checkpoint_id").on(table.baseCheckpointId),
    headCheckpointIdx: index("v2_idx_spaces_head_checkpoint_id").on(table.headCheckpointId),
    nameSearchIdx: index("v2_idx_spaces_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
    descriptionSearchIdx: index("v2_idx_spaces_description_trgm").using("gin", table.description.op("gin_trgm_ops")),
    userSpaceNameUniqueIdx: uniqueIndex("v2_uq_spaces_user_name").on(table.userUuid, table.name),
    userSpaceSlugUniqueIdx: uniqueIndex("v2_uq_spaces_user_slug")
      .on(table.userUuid, table.slug)
      .where(sql`${table.slug} is not null`),
    spaceSlugFormatCheck: check(
      "v2_chk_spaces_slug_format",
      sql`${table.slug} is null or (length(${table.slug}) between 1 and 80 and ${table.slug} !~ '[^a-z0-9_-]' and left(${table.slug}, 1) ~ '[a-z0-9]' and right(${table.slug}, 1) ~ '[a-z0-9]')`,
    ),
    storageRepoNameUniqueIdx: uniqueIndex("v2_uq_spaces_storage_repo_name").on(
      table.storageRepoName,
    ),
  }),
);

export const spaceVoiceLexiconEntries = v2.table(
  "space_voice_lexicon_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    term: text("term").notNull(),
    termKey: varchar("term_key", { length: 120 }).notNull(),
    source: varchar("source", { length: 20 }).$type<VoiceLexiconSource>().notNull().default("manual"),
    originalText: text("original_text"),
    usageCount: integer("usage_count").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_voice_lexicon_space_id").on(table.spaceId),
    spaceTermUniqueIdx: uniqueIndex("v2_uq_space_voice_lexicon_space_term").on(
      table.spaceId,
      table.termKey,
    ),
  }),
);

export const spaceMods = v2.table(
  "space_mods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    modSpaceId: uuid("mod_space_id").notNull(),
    name: varchar("name", { length: 255 }),
    mountSlug: varchar("mount_slug", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_mods_space_id").on(table.spaceId),
    modSpaceIdx: index("v2_idx_space_mods_mod_space_id").on(table.modSpaceId),
    spaceModUniqueIdx: uniqueIndex("v2_uq_space_mods_space_mod").on(
      table.spaceId,
      table.modSpaceId,
    ),
    spaceMountSlugUniqueIdx: uniqueIndex("v2_uq_space_mods_space_mount_slug").on(
      table.spaceId,
      table.mountSlug,
    ),
  }),
);

export const spaceSandboxes = v2.table(
  "space_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    runtimeStatus: varchar("runtime_status", { length: 30 }).notNull().default("unknown"),
    podName: varchar("pod_name", { length: 255 }),
    desiredImage: text("desired_image"),
    reportedImageVersion: varchar("reported_image_version", { length: 255 }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopReason: varchar("stop_reason", { length: 30 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: uniqueIndex("v2_uq_space_sandboxes_space_id").on(table.spaceId),
    statusIdx: index("v2_idx_space_sandboxes_status").on(table.status),
    desiredImageIdx: index("v2_idx_space_sandboxes_desired_image").on(table.desiredImage),
    reportedImageVersionIdx: index("v2_idx_space_sandboxes_reported_image_version").on(table.reportedImageVersion),
    heartbeatIdx: index("v2_idx_space_sandboxes_last_heartbeat_at").on(table.lastHeartbeatAt),
    activityIdx: index("v2_idx_space_sandboxes_last_activity_at").on(table.lastActivityAt),
    runtimeStatusIdx: index("v2_idx_space_sandboxes_runtime_status").on(table.runtimeStatus),
    stoppedAtIdx: index("v2_idx_space_sandboxes_stopped_at").on(table.stoppedAt),
  }),
);

export const checkpoints = v2.table(
  "checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    commitHash: varchar("commit_hash", { length: 40 }).notNull(),
    description: text("description").notNull(),
    parentCheckpointId: uuid("parent_checkpoint_id"),
    rootCheckpointId: uuid("root_checkpoint_id"),
    forkCount: integer("fork_count").notNull().default(0),
    saveVersion: integer("save_version").notNull().default(1),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_checkpoints_space_id").on(table.spaceId),
    parentIdx: index("v2_idx_checkpoints_parent_id").on(table.parentCheckpointId),
    rootIdx: index("v2_idx_checkpoints_root_id").on(table.rootCheckpointId),
    spaceCommitUniqueIdx: uniqueIndex("v2_uq_checkpoints_space_commit").on(
      table.spaceId,
      table.commitHash,
    ),
  }),
);

export const works = v2.table(
  "works",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetRef: text("target_ref").notNull(),
    assetKey: text("asset_key"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    workScopes: jsonb("work_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    allowedViewerScopes: jsonb("allowed_viewer_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_works_space_id").on(table.spaceId),
    userUuidIdx: index("v2_idx_works_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_works_status").on(table.status),
    spaceSlugUniqueIdx: uniqueIndex("v2_uq_works_space_slug").on(table.spaceId, table.slug),
    slugFormatCheck: check(
      "v2_chk_works_slug_format",
      sql`length(${table.slug}) between 1 and 80 and ${table.slug} !~ '[^a-z0-9_-]' and left(${table.slug}, 1) ~ '[a-z0-9]' and right(${table.slug}, 1) ~ '[a-z0-9]'`,
    ),
  }),
);

export const workViewerGrants = v2.table(
  "work_viewer_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workId: uuid("work_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    viewerUserUuid: varchar("viewer_user_uuid", { length: 255 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    workIdx: index("v2_idx_work_viewer_grants_work_id").on(table.workId),
    spaceIdx: index("v2_idx_work_viewer_grants_space_id").on(table.spaceId),
    viewerIdx: index("v2_idx_work_viewer_grants_viewer_user_uuid").on(table.viewerUserUuid),
    workViewerUniqueIdx: uniqueIndex("v2_uq_work_viewer_grants_work_viewer").on(table.workId, table.viewerUserUuid),
  }),
);

export const canvasDocuments = v2.table(
  "canvas_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    filePath: text("file_path").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull().default(0),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    spaceIdx: index("v2_idx_canvas_documents_space_id").on(table.spaceId),
    spacePathUniqueIdx: uniqueIndex("v2_uq_canvas_documents_space_path").on(table.spaceId, table.filePath),
  }),
);

export const canvasNodes = v2.table(
  "canvas_nodes",
  {
    documentId: uuid("document_id").notNull(),
    nodeId: text("node_id").notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    parentId: text("parent_id"),
    orderKey: text("order_key"),
    x: doublePrecision("x").notNull().default(0),
    y: doublePrecision("y").notNull().default(0),
    width: doublePrecision("width").notNull().default(240),
    height: doublePrecision("height").notNull().default(160),
    rotation: doublePrecision("rotation").notNull().default(0),
    refKind: varchar("ref_kind", { length: 40 }),
    refPath: text("ref_path"),
    refUrl: text("ref_url"),
    view: jsonb("view").$type<Record<string, unknown>>().notNull().default({}),
    style: jsonb("style").$type<Record<string, unknown>>().notNull().default({}),
    animation: jsonb("animation").$type<Record<string, unknown>>().notNull().default({}),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_canvas_nodes_document_node").on(table.documentId, table.nodeId),
    documentIdx: index("v2_idx_canvas_nodes_document_id").on(table.documentId),
    viewportIdx: index("v2_idx_canvas_nodes_viewport").on(table.documentId, table.x, table.y, table.width, table.height),
    refPathIdx: index("v2_idx_canvas_nodes_ref_path").on(table.documentId, table.refPath),
  }),
);

export const canvasUpdates = v2.table(
  "canvas_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    actorId: varchar("actor_id", { length: 255 }).notNull(),
    clientId: text("client_id"),
    type: varchar("type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    undoGroupId: text("undo_group_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    documentVersionUniqueIdx: uniqueIndex("v2_uq_canvas_updates_document_version").on(table.documentId, table.version),
    documentIdx: index("v2_idx_canvas_updates_document_id").on(table.documentId),
  }),
);

export const canvasCheckpointSnapshots = v2.table(
  "canvas_checkpoint_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkpointId: uuid("checkpoint_id").notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceSpaceId: uuid("source_space_id").notNull(),
    sourceFilePath: text("source_file_path").notNull(),
    sourceVersion: integer("source_version").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    checkpointPathUniqueIdx: uniqueIndex("v2_uq_canvas_checkpoint_snapshots_path").on(table.checkpointId, table.sourceFilePath),
    checkpointIdx: index("v2_idx_canvas_checkpoint_snapshots_checkpoint_id").on(table.checkpointId),
  }),
);

export const proposals = v2.table(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    sourceCheckpointId: uuid("source_checkpoint_id").notNull(),
    targetSpaceId: uuid("target_space_id").notNull(),
    sourceBranchName: varchar("source_branch_name", { length: 255 }),
    targetBranchName: varchar("target_branch_name", { length: 255 }),
    externalPrId: varchar("external_pr_id", { length: 255 }),
    status: varchar("status", { length: 20 }).default("open"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    targetSpaceIdx: index("v2_idx_proposals_target_space_id").on(table.targetSpaceId),
    sourceCheckpointIdx: index("v2_idx_proposals_source_checkpoint_id").on(table.sourceCheckpointId),
    statusIdx: index("v2_idx_proposals_status").on(table.status),
  }),
);

export const spaceChannels = v2.table(
  "space_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_channels_space").on(table.spaceId),
    channelIdx: uniqueIndex("v2_uq_space_channels_channel").on(table.channelId),
  }),
);

export const spaceSessions = v2.table(
  "space_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }),
    title: varchar("title", { length: 255 }),
    source: varchar("source", { length: 255 }),
    status: varchar("status", { length: 50 }).default("active"),
    externalSessionId: text("external_session_id"),
    meta: jsonb("meta"),
    latestMessageText: text("latest_message_text"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageId: uuid("last_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_sessions_space_id").on(table.spaceId),
    userUuidIdx: index("v2_idx_space_sessions_user_uuid").on(table.userUuid),
    lastMessageIdx: index("v2_idx_space_sessions_last_message_id").on(table.lastMessageId),
    lastMessageAtIdx: index("v2_idx_space_sessions_last_message_at").on(table.lastMessageAt),
    titleSearchIdx: index("v2_idx_space_sessions_title_trgm").using("gin", table.title.op("gin_trgm_ops")),
    spaceLastMessageIdx: index("v2_idx_space_sessions_space_last_message_id").on(
      table.spaceId,
      table.lastMessageAt.desc().nullsLast(),
      table.id.desc(),
    ),
  }),
);

export const sessionForks = v2.table(
  "session_forks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    parentSessionId: uuid("parent_session_id").notNull(),
    childSessionId: uuid("child_session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    depth: integer("depth").notNull(),
    anchorSourceSessionId: uuid("anchor_source_session_id").notNull(),
    anchorTurnId: uuid("anchor_turn_id").notNull(),
    anchorSequence: integer("anchor_sequence").notNull(),
    ancestorSessionIds: uuid("ancestor_session_ids").array().notNull(),
    sessionPath: uuid("session_path").array().notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    childUniqueIdx: uniqueIndex("v2_uq_session_forks_child").on(table.childSessionId),
    parentIdx: index("v2_idx_session_forks_parent").on(table.parentSessionId),
    rootDepthIdx: index("v2_idx_session_forks_root_depth").on(table.rootSessionId, table.depth, table.createdAt),
    anchorTurnIdx: index("v2_idx_session_forks_anchor_turn").on(table.anchorTurnId),
  }),
);

export const sessionTurnSegments = v2.table(
  "session_turn_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceSessionId: uuid("source_session_id").notNull(),
    fromSequence: integer("from_sequence").notNull(),
    toSequence: integer("to_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionOrdinalUniqueIdx: uniqueIndex("v2_uq_session_turn_segments_session_ordinal").on(table.sessionId, table.ordinal),
    sessionIdx: index("v2_idx_session_turn_segments_session").on(table.sessionId, table.ordinal),
    sourceIdx: index("v2_idx_session_turn_segments_source").on(table.sourceSessionId),
  }),
);

export const spaceSessionBindings = v2.table(
  "space_session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    spaceSessionId: uuid("space_session_id").notNull(),
    spaceChannelId: uuid("space_channel_id").notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    bindingKey: varchar("binding_key", { length: 255 }).notNull(),
    externalChatId: varchar("external_chat_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_session_bindings_space").on(table.spaceId),
    sessionIdx: index("v2_idx_space_session_bindings_session").on(table.spaceSessionId),
    channelIdx: index("v2_idx_space_session_bindings_channel").on(table.spaceChannelId),
    bindingKeyIdx: index("v2_idx_space_session_bindings_binding_key").on(table.bindingKey),
    externalChatIdx: index("v2_idx_space_session_bindings_external_chat").on(table.externalChatId),
    uniqueChannelBinding: uniqueIndex("v2_uq_space_session_bindings_channel_binding").on(
      table.spaceChannelId,
      table.bindingKey,
    ),
  }),
);

export const providerMessageRefs = v2.table(
  "provider_message_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 50 }).notNull(),
    spaceId: uuid("space_id").notNull(),
    spaceSessionId: uuid("space_session_id").notNull(),
    spaceChannelId: uuid("space_channel_id"),
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
    providerConversationIdx: index("v2_idx_provider_message_refs_provider_conversation").on(
      table.provider,
      table.externalConversationId,
    ),
    providerMessageIdx: uniqueIndex("v2_uq_provider_message_refs_provider_message").on(
      table.provider,
      table.externalConversationId,
      table.externalMessageId,
      table.direction,
    ),
    spaceSessionIdx: index("v2_idx_provider_message_refs_space_session").on(table.spaceSessionId),
    sessionMessageIdx: index("v2_idx_provider_message_refs_session_message").on(
      table.sessionMessageId,
    ),
    parentMessageIdx: index("v2_idx_provider_message_refs_parent_message").on(
      table.provider,
      table.parentExternalConversationId,
      table.parentExternalMessageId,
    ),
    spaceChannelIdx: index("v2_idx_provider_message_refs_space_channel").on(table.spaceChannelId),
  }),
);

export const sessionTurns = v2.table(
  "session_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }),
    sequence: integer("sequence").notNull(),
    status: varchar("status", { length: 20 }).$type<SessionTurnStatus>().notNull().default("queued"),
    intent: varchar("intent", { length: 20 }).$type<SessionTurnIntent>().notNull().default("steer"),
    userContent: jsonb("user_content").notNull().$type<ContentBlock[]>(),
    userText: text("user_text"),
    assistantContent: jsonb("assistant_content").$type<ContentBlock[] | null>(),
    assistantText: text("assistant_text"),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    stopReason: varchar("stop_reason", { length: 50 }),
    errorMessage: text("error_message"),
    finalUsage: jsonb("final_usage").$type<import("@cohub/protocol/core").Usage | null>(),
    totalUsage: jsonb("total_usage").$type<import("@cohub/protocol/core").Usage | null>(),
    summary: jsonb("summary").$type<SessionTurnSummary | null>(),
    intermediateIndex: jsonb("intermediate_index").$type<SessionTurnIntermediateIndex | null>(),
    intermediateSummary: jsonb("intermediate_summary").$type<SessionTurnIntermediateSummary | null>(),
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index("v2_idx_session_turns_session_id").on(table.sessionId),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_turns_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    userUuidIdx: index("v2_idx_session_turns_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_session_turns_status").on(table.status),
    createdAtIdx: index("v2_idx_session_turns_created_at").on(table.createdAt),
    userTextSearchIdx: index("v2_idx_session_turns_user_text_trgm").using("gin", table.userText.op("gin_trgm_ops")),
  }),
);

export const sessionMessages = v2.table(
  "session_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    content: jsonb("content").notNull().$type<ContentBlock[]>(),
    text: text("text"),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    stopReason: varchar("stop_reason", { length: 50 }),
    errorMessage: text("error_message"),
    sequence: integer("sequence").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    usage: jsonb("usage").$type<import("@cohub/protocol/core").Usage | null>(),
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index("v2_idx_session_messages_session_id").on(table.sessionId),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_messages_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    idempotencyKeyUniqueIdx: uniqueIndex("v2_uq_session_messages_session_id_idempotency_key").on(
      table.sessionId,
      table.idempotencyKey,
    ),
  }),
);

export const tokenUsageStatsHourly = v2.table(
  "token_usage_stats_hourly",
  {
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    spaceId: uuid("space_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costInput: numeric("cost_input", { precision: 18, scale: 8 }).notNull().default("0"),
    costOutput: numeric("cost_output", { precision: 18, scale: 8 }).notNull().default("0"),
    costCacheRead: numeric("cost_cache_read", { precision: 18, scale: 8 }).notNull().default("0"),
    costCacheWrite: numeric("cost_cache_write", { precision: 18, scale: 8 }).notNull().default("0"),
    costTotal: numeric("cost_total", { precision: 18, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("v2_uq_token_usage_stats_hourly_bucket_dims").on(
      table.bucketStartAt,
      table.userId,
      table.spaceId,
      table.sessionId,
      table.provider,
      table.model,
    ),
    bucketIdx: index("v2_idx_token_usage_stats_hourly_bucket").on(table.bucketStartAt),
    userBucketIdx: index("v2_idx_token_usage_stats_hourly_user_bucket").on(table.userId, table.bucketStartAt),
    spaceBucketIdx: index("v2_idx_token_usage_stats_hourly_space_bucket").on(table.spaceId, table.bucketStartAt),
    sessionBucketIdx: index("v2_idx_token_usage_stats_hourly_session_bucket").on(table.sessionId, table.bucketStartAt),
    providerModelBucketIdx: index("v2_idx_token_usage_stats_hourly_provider_model_bucket").on(table.provider, table.model, table.bucketStartAt),
  }),
);

export const gatewayLogs = v2.table(
  "gateway_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: varchar("direction", { length: 10 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    channelId: uuid("channel_id"),
    externalChatId: varchar("external_chat_id", { length: 255 }),
    rawPayload: jsonb("raw_payload").notNull(),
    normalizedPayload: jsonb("normalized_payload"),
    status: varchar("status", { length: 20 }).default("success"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    channelIdx: index("v2_idx_gateway_logs_channel").on(table.channelId),
    directionIdx: index("v2_idx_gateway_logs_direction").on(table.direction),
    createdIdx: index("v2_idx_gateway_logs_created").on(table.createdAt),
  }),
);

export const spaceMembers = v2.table(
  "space_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).$type<SpaceRole>().notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    updatedBy: varchar("updated_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueSpaceUserIdx: uniqueIndex("v2_uq_space_members_space_user").on(
      table.spaceId,
      table.userId,
    ),
    spaceIdx: index("v2_idx_space_members_space").on(table.spaceId),
    userIdx: index("v2_idx_space_members_user").on(table.userId),
    userSpaceIdx: index("v2_idx_space_members_user_space").on(table.userId, table.spaceId),
    spaceRoleIdx: index("v2_idx_space_members_space_role").on(table.spaceId, table.role),
  }),
);

export const accessPolicies = v2.table(
  "access_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceType: varchar("resource_type", { length: 20 }).$type<AccessPolicyResourceType>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    signedInUserRole: varchar("signed_in_user_role", { length: 20 }).$type<SpaceRole | null>(),
    anonymousUserRole: varchar("anonymous_user_role", { length: 20 }).$type<SpaceRole | null>(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    updatedBy: varchar("updated_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueResourceIdx: uniqueIndex("v2_uq_access_policies_resource").on(
      table.resourceType,
      table.resourceId,
    ),
    resourceIdx: index("v2_idx_access_policies_resource").on(table.resourceType, table.resourceId),
  }),
);

export const spaceMarks = v2.table(
  "space_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    kind: varchar("kind", { length: 30 }).notNull(),
    resourceType: varchar("resource_type", { length: 30 }).notNull(),
    resourceRef: text("resource_ref").notNull(),
    label: text("label"),
    rank: integer("rank").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueResourceMarkIdx: uniqueIndex("v2_uq_space_marks_resource").on(
      table.spaceId,
      table.kind,
      table.resourceType,
      table.resourceRef,
    ),
    spaceKindRankIdx: index("v2_idx_space_marks_space_kind_rank").on(
      table.spaceId,
      table.kind,
      table.rank,
    ),
    spaceResourceIdx: index("v2_idx_space_marks_space_resource").on(
      table.spaceId,
      table.resourceType,
      table.resourceRef,
    ),
  }),
);

export const labels = v2.table(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    scopeId: text("scope_id").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    parentId: uuid("parent_id"),
    depth: integer("depth").notNull().default(0),
    source: varchar("source", { length: 30 }).notNull().default("user"),
    systemKey: varchar("system_key", { length: 120 }),
    rank: integer("rank").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    scopeRankIdx: index("v2_idx_labels_scope_rank").on(
      table.scopeType,
      table.scopeId,
      table.rank,
    ),
    scopeParentIdx: index("v2_idx_labels_scope_parent").on(
      table.scopeType,
      table.scopeId,
      table.parentId,
    ),
    siblingNameUniqueIdx: uniqueIndex("v2_uq_labels_scope_parent_name").on(
      table.scopeType,
      table.scopeId,
      sql`coalesce(${table.parentId}::text, '')`,
      sql`lower(${table.name})`,
    ),
    systemKeyUniqueIdx: uniqueIndex("v2_uq_labels_scope_system_key").on(
      table.scopeType,
      table.scopeId,
      table.systemKey,
    ),
    depthCheck: check("v2_chk_labels_depth", sql`${table.depth} in (0, 1)`),
  }),
);

export const labelAssignments = v2.table(
  "label_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    labelId: uuid("label_id").notNull(),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    scopeId: text("scope_id").notNull(),
    resourceType: varchar("resource_type", { length: 30 }).notNull(),
    resourceRef: text("resource_ref").notNull(),
    rank: integer("rank").notNull().default(0),
    source: varchar("source", { length: 30 }).notNull().default("user"),
    createdBy: varchar("created_by", { length: 255 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueLabelResourceIdx: uniqueIndex("v2_uq_label_assignments_label_resource").on(
      table.labelId,
      table.resourceType,
      table.resourceRef,
    ),
    labelRankIdx: index("v2_idx_label_assignments_label_rank").on(
      table.labelId,
      table.rank,
    ),
    scopeResourceIdx: index("v2_idx_label_assignments_scope_resource").on(
      table.scopeType,
      table.scopeId,
      table.resourceType,
      table.resourceRef,
    ),
    scopeLabelIdx: index("v2_idx_label_assignments_scope_label").on(
      table.scopeType,
      table.scopeId,
      table.labelId,
    ),
    resourceLabelIdx: index("v2_idx_label_assignments_resource_label").on(
      table.resourceType,
      table.resourceRef,
      table.labelId,
    ),
  }),
);

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
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userIdx: index("v2_idx_cron_jobs_user_uuid").on(table.userUuid),
    spaceIdx: index("v2_idx_cron_jobs_space_id").on(table.spaceId),
    enabledIdx: index("v2_idx_cron_jobs_enabled").on(table.enabled),
    createdAtIdx: index("v2_idx_cron_jobs_created_at").on(table.createdAt),
  }),
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
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    turnId: uuid("turn_id"),
    userUuid: varchar("user_uuid", { length: 255 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    jobIdUniqueIdx: uniqueIndex("v2_uq_task_runs_job_id").on(table.jobId),
    cronJobIdx: index("v2_idx_task_runs_cron_job_id").on(table.cronJobId),
    spaceIdx: index("v2_idx_task_runs_space_id").on(table.spaceId),
    sessionIdx: index("v2_idx_task_runs_session_id").on(table.sessionId),
    turnIdx: index("v2_idx_task_runs_turn_id").on(table.turnId),
    sessionTurnIdx: index("v2_idx_task_runs_session_turn").on(table.sessionId, table.turnId),
    userIdx: index("v2_idx_task_runs_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_task_runs_status").on(table.status),
    createdAtIdx: index("v2_idx_task_runs_created_at").on(table.createdAt),
    scheduledAtIdx: index("v2_idx_task_runs_scheduled_at").on(table.scheduledAt),
  }),
);
