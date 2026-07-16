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
  unique,
  check,
  doublePrecision,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ContentBlock } from "@cohub/protocol/core";
import type { TaskPayload } from "@cohub/protocol/task";
import type { RealtimeRoom, RealtimeServerEvent } from "@cohub/protocol/realtime";
import type { BillingUsageDeliveryPayload } from "@cohub/protocol/billing";
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
export type ReferralCodeStatus = "active" | "revoked";
export type ReferralStatus = "pending" | "qualified" | "rewarded";
export type RealtimeOutboxEnvelope = RealtimeServerEvent & { rooms?: RealtimeRoom[] };
export type OutboxPayload = RealtimeOutboxEnvelope | BillingUsageDeliveryPayload;
export type BillingUsageAttemptStatus = "recorded" | "overage" | "disabled" | "skipped" | "error";

export type UserChannelCredentialEnvelope = {
  version: 1;
  keyId: string;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
};

/** Endpoints of a reference: the kinds of resources that can point or be pointed at. */
export type ReferenceResourceType =
  | "space"
  | "session"
  | "checkpoint"
  | "user"
  | "file"
  | "tool";

/** The nature of a reference between two resources. */
export type ReferenceKind =
  | "session_fork"
  | "space_fork"
  | "checkpoint_fork"
  | "mention"
  | "tool_call"
  | "mod"
  | "participant";

export const v2 = pgSchema("v2");

export const outboxEvents = v2.table(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    destination: varchar("destination", { length: 50 }).notNull(),
    deduplicationKey: varchar("deduplication_key", { length: 255 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 100 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 255 }).notNull(),
    aggregateSequence: integer("aggregate_sequence"),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<OutboxPayload>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deduplicationKeyUniqueIdx: uniqueIndex("v2_uq_outbox_events_deduplication_key").on(table.deduplicationKey),
    aggregateSequenceUniqueIdx: uniqueIndex("v2_uq_outbox_events_aggregate_sequence")
      .on(table.destination, table.aggregateType, table.aggregateId, table.aggregateSequence)
      .where(sql`${table.aggregateSequence} IS NOT NULL`),
    pendingIdx: index("v2_idx_outbox_events_pending")
      .on(table.availableAt, table.occurredAt, table.id)
      .where(sql`${table.publishedAt} IS NULL AND ${table.failedAt} IS NULL`),
    publishedAtIdx: index("v2_idx_outbox_events_published_at")
      .on(table.publishedAt)
      .where(sql`${table.publishedAt} IS NOT NULL`),
    failedAtIdx: index("v2_idx_outbox_events_failed_at")
      .on(table.failedAt)
      .where(sql`${table.failedAt} IS NOT NULL`),
    attemptCountCheck: check("v2_chk_outbox_events_attempt_count", sql`${table.attemptCount} >= 0`),
    aggregateSequenceCheck: check(
      "v2_chk_outbox_events_aggregate_sequence",
      sql`${table.aggregateSequence} IS NULL OR ${table.aggregateSequence} > 0`,
    ),
    deliveryStateCheck: check(
      "v2_chk_outbox_events_delivery_state",
      sql`${table.publishedAt} IS NULL OR ${table.failedAt} IS NULL`,
    ),
  }),
);

export const billingUsageIntents = v2.table(
  "billing_usage_intents",
  {
    operationId: varchar("operation_id", { length: 255 }).primaryKey(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    tokenType: varchar("token_type", { length: 100 }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 18, scale: 8 }).notNull(),
    usageType: varchar("usage_type", { length: 100 }).notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    reason: text("reason"),
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("v2_idx_billing_usage_intents_user_created")
      .on(table.userId, table.createdAt.desc(), table.operationId),
    sourceIdx: index("v2_idx_billing_usage_intents_source").on(table.sourceId),
    spaceCreatedIdx: index("v2_idx_billing_usage_intents_space_created")
      .on(table.spaceId, table.createdAt.desc(), table.operationId),
    amountCheck: check("v2_chk_billing_usage_intents_amount", sql`${table.amountUsd} > 0`),
    identityCheck: check(
      "v2_chk_billing_usage_intents_identity",
      sql`length(btrim(${table.operationId})) > 0 AND length(btrim(${table.userId})) > 0 AND length(btrim(${table.tokenType})) > 0 AND length(btrim(${table.usageType})) > 0 AND length(btrim(${table.sourceId})) > 0`,
    ),
    requestHashCheck: check(
      "v2_chk_billing_usage_intents_request_hash",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const billingUsageAttempts = v2.table(
  "billing_usage_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: varchar("operation_id", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).$type<BillingUsageAttemptStatus>().notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    errorName: varchar("error_name", { length: 255 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationFk: foreignKey({
      name: "v2_fk_billing_usage_attempts_operation",
      columns: [table.operationId],
      foreignColumns: [billingUsageIntents.operationId],
    }).onDelete("restrict"),
    operationCreatedIdx: index("v2_idx_billing_usage_attempts_operation_created")
      .on(table.operationId, table.createdAt, table.id),
    statusCreatedIdx: index("v2_idx_billing_usage_attempts_status_created")
      .on(table.status, table.createdAt, table.id),
    statusCheck: check(
      "v2_chk_billing_usage_attempts_status",
      sql`${table.status} IN ('recorded', 'overage', 'disabled', 'skipped', 'error')`,
    ),
    resultCheck: check(
      "v2_chk_billing_usage_attempts_result",
      sql`(${table.status} = 'error' AND ${table.errorMessage} IS NOT NULL AND ${table.response} IS NULL) OR (${table.status} <> 'error' AND ${table.errorName} IS NULL AND ${table.errorMessage} IS NULL)`,
    ),
    providerCheck: check(
      "v2_chk_billing_usage_attempts_provider",
      sql`length(btrim(${table.provider})) > 0`,
    ),
  }),
);

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
    credentialEnvelope: jsonb("credential_envelope").$type<UserChannelCredentialEnvelope>().notNull(),
    credentialRevision: integer("credential_revision").default(1).notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_user_channels_user_uuid").on(table.userUuid),
    providerIdx: index("v2_idx_user_channels_provider").on(table.provider),
    credentialEnvelopeCheck: check(
      "v2_chk_user_channels_credential_envelope",
      sql`coalesce(
        jsonb_typeof(${table.credentialEnvelope}) = 'object'
        and ${table.credentialEnvelope}->'version' = '1'::jsonb
        and ${table.credentialEnvelope}->>'algorithm' = 'aes-256-gcm'
        and ${table.credentialEnvelope}->>'keyId' ~ '^[A-Za-z0-9._-]{1,64}$'
        and ${table.credentialEnvelope}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
        and ${table.credentialEnvelope}->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
        and ${table.credentialEnvelope}->>'ciphertext' ~ '^[A-Za-z0-9_-]{3,}$',
        false
      )`,
    ),
    credentialRevisionCheck: check(
      "v2_chk_user_channels_credential_revision",
      sql`${table.credentialRevision} > 0`,
    ),
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
    baseCheckpointId: uuid("base_checkpoint_id").references(
      (): AnyPgColumn => checkpoints.id,
      { onDelete: "set null" },
    ),
    headCheckpointId: uuid("head_checkpoint_id").references(
      (): AnyPgColumn => checkpoints.id,
      { onDelete: "set null" },
    ),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_spaces_user_uuid").on(table.userUuid),
    baseCheckpointIdx: index("v2_idx_spaces_base_checkpoint_id").on(table.baseCheckpointId),
    headCheckpointIdx: index("v2_idx_spaces_head_checkpoint_id").on(table.headCheckpointId),
    lastActivityIdx: index("v2_idx_spaces_last_activity_at").on(table.lastActivityAt.desc().nullsLast(), table.createdAt.desc().nullsLast()),
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
    spaceFk: foreignKey({
      name: "v2_fk_space_mods_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    modSpaceFk: foreignKey({
      name: "v2_fk_space_mods_mod_space",
      columns: [table.modSpaceId],
      foreignColumns: [spaces.id],
    }).onDelete("restrict"),
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
    provider: varchar("provider", { length: 20 }).notNull().default("cloud"),
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
    spaceFk: foreignKey({
      name: "v2_fk_space_sandboxes_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    spaceIdx: uniqueIndex("v2_uq_space_sandboxes_space_id").on(table.spaceId),
    statusIdx: index("v2_idx_space_sandboxes_status").on(table.status),
    desiredImageIdx: index("v2_idx_space_sandboxes_desired_image").on(table.desiredImage),
    reportedImageVersionIdx: index("v2_idx_space_sandboxes_reported_image_version").on(table.reportedImageVersion),
    heartbeatIdx: index("v2_idx_space_sandboxes_last_heartbeat_at").on(table.lastHeartbeatAt),
    activityIdx: index("v2_idx_space_sandboxes_last_activity_at").on(table.lastActivityAt),
    runtimeStatusIdx: index("v2_idx_space_sandboxes_runtime_status").on(table.runtimeStatus),
    stoppedAtIdx: index("v2_idx_space_sandboxes_stopped_at").on(table.stoppedAt),
    providerCheck: check(
      "v2_chk_space_sandboxes_provider",
      sql`${table.provider} in ('cloud', 'local')`,
    ),
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
    spaceFk: foreignKey({
      name: "v2_fk_checkpoints_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    parentFk: foreignKey({
      name: "v2_fk_checkpoints_parent",
      columns: [table.parentCheckpointId],
      foreignColumns: [table.id],
    }).onDelete("no action"),
    rootFk: foreignKey({
      name: "v2_fk_checkpoints_root",
      columns: [table.rootCheckpointId],
      foreignColumns: [table.id],
    }).onDelete("no action"),
    spaceIdx: index("v2_idx_checkpoints_space_id").on(table.spaceId),
    parentIdx: index("v2_idx_checkpoints_parent_id").on(table.parentCheckpointId),
    rootIdx: index("v2_idx_checkpoints_root_id").on(table.rootCheckpointId),
    descriptionSearchIdx: index("v2_idx_checkpoints_description_trgm").using("gin", table.description.op("gin_trgm_ops")),
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
    status: varchar("status", { length: 20 }).notNull().default("disabled"),
    visibility: varchar("visibility", { length: 20 }).notNull().default("public"),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetRef: text("target_ref").notNull(),
    assetKey: text("asset_key"),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => workVersions.id,
      { onDelete: "set null" },
    ),
    latestVersion: integer("latest_version").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    workScopes: jsonb("work_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    allowedViewerScopes: jsonb("allowed_viewer_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceFk: foreignKey({
      name: "v2_fk_works_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    spaceIdx: index("v2_idx_works_space_id").on(table.spaceId),
    userUuidIdx: index("v2_idx_works_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_works_status").on(table.status),
    visibilityIdx: index("v2_idx_works_visibility").on(table.visibility),
    statusCheck: check("v2_chk_works_status", sql`${table.status} in ('published', 'disabled')`),
    visibilityCheck: check("v2_chk_works_visibility", sql`${table.visibility} in ('public', 'space')`),
    idSpaceUniqueIdx: uniqueIndex("v2_uq_works_id_space").on(table.id, table.spaceId),
    spaceSlugUniqueIdx: uniqueIndex("v2_uq_works_space_slug").on(table.spaceId, table.slug),
    slugFormatCheck: check(
      "v2_chk_works_slug_format",
      sql`length(${table.slug}) between 1 and 80 and ${table.slug} !~ '[^a-z0-9_-]' and left(${table.slug}, 1) ~ '[a-z0-9]' and right(${table.slug}, 1) ~ '[a-z0-9]'`,
    ),
  }),
);

export const workVersions = v2.table(
  "work_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workId: uuid("work_id").notNull(),
    version: integer("version").notNull(),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetRef: text("target_ref").notNull(),
    assetKey: text("asset_key"),
    /** Optional provenance / notes for this version (e.g. source session/turn). */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    workFk: foreignKey({
      name: "v2_fk_work_versions_work",
      columns: [table.workId],
      foreignColumns: [works.id],
    }).onDelete("cascade"),
    workIdx: index("v2_idx_work_versions_work_id").on(table.workId),
    workVersionUniqueIdx: uniqueIndex("v2_uq_work_versions_work_version").on(table.workId, table.version),
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
    workSpaceFk: foreignKey({
      name: "v2_fk_work_viewer_grants_work_space",
      columns: [table.workId, table.spaceId],
      foreignColumns: [works.id, works.spaceId],
    }).onDelete("cascade"),
    workIdx: index("v2_idx_work_viewer_grants_work_id").on(table.workId),
    spaceIdx: index("v2_idx_work_viewer_grants_space_id").on(table.spaceId),
    viewerIdx: index("v2_idx_work_viewer_grants_viewer_user_uuid").on(table.viewerUserUuid),
    workViewerUniqueIdx: uniqueIndex("v2_uq_work_viewer_grants_work_viewer").on(table.workId, table.viewerUserUuid),
  }),
);

export const spaceCommerceBusinesses = v2.table(
  "space_commerce_businesses",
  {
    spaceId: uuid("space_id").primaryKey(),
    billingBusinessKey: varchar("billing_business_key", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceFk: foreignKey({
      name: "v2_fk_space_commerce_businesses_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    businessKeyUniqueIdx: uniqueIndex("v2_uq_space_commerce_businesses_business_key").on(table.billingBusinessKey),
  }),
);

export const canvasDocuments = v2.table(
  "canvas_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull().default(0),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    spaceIdx: index("v2_idx_canvas_documents_space_id").on(table.spaceId),
    spacePathUniqueIdx: uniqueIndex("v2_uq_canvas_documents_space_path").on(table.spaceId, table.filePath),
    versionCheck: check("v2_chk_canvas_documents_version", sql`${table.version} >= 0`),
  }),
);

export const canvasNodes = v2.table(
  "canvas_nodes",
  {
    documentId: uuid("document_id").notNull().references(() => canvasDocuments.id, { onDelete: "cascade" }),
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
    viewportIdx: index("v2_idx_canvas_nodes_viewport").on(table.documentId, table.x, table.y, table.width, table.height),
    refPathIdx: index("v2_idx_canvas_nodes_ref_path").on(table.documentId, table.refPath),
    dimensionsCheck: check("v2_chk_canvas_nodes_dimensions", sql`${table.width} > 0 AND ${table.height} > 0`),
    versionCheck: check("v2_chk_canvas_nodes_version", sql`${table.version} >= 0`),
  }),
);

export const canvasUpdates = v2.table(
  "canvas_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull().references(() => canvasDocuments.id, { onDelete: "cascade" }),
    txId: text("tx_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    requestHash: varchar("request_hash", { length: 64 }),
    version: integer("version").notNull(),
    actorId: varchar("actor_id", { length: 255 }).notNull(),
    clientId: text("client_id"),
    type: varchar("type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    undoGroupId: text("undo_group_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    documentVersionUniqueIdx: uniqueIndex("v2_uq_canvas_updates_document_version").on(table.documentId, table.version),
    documentTxUniqueIdx: uniqueIndex("v2_uq_canvas_updates_document_tx").on(table.documentId, table.txId),
    baseVersionCheck: check("v2_chk_canvas_updates_base_version", sql`${table.baseVersion} >= 0`),
    versionCheck: check("v2_chk_canvas_updates_version", sql`${table.version} > ${table.baseVersion}`),
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
    checkpointFk: foreignKey({
      name: "v2_fk_canvas_checkpoint_snapshots_checkpoint",
      columns: [table.checkpointId],
      foreignColumns: [checkpoints.id],
    }).onDelete("cascade"),
    sourceDocumentFk: foreignKey({
      name: "v2_fk_canvas_checkpoint_snapshots_source_document",
      columns: [table.sourceDocumentId],
      foreignColumns: [canvasDocuments.id],
    }).onDelete("cascade"),
    sourceSpaceFk: foreignKey({
      name: "v2_fk_canvas_checkpoint_snapshots_source_space",
      columns: [table.sourceSpaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
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
    sourceCheckpointFk: foreignKey({
      name: "v2_fk_proposals_source_checkpoint",
      columns: [table.sourceCheckpointId],
      foreignColumns: [checkpoints.id],
    }).onDelete("no action"),
    targetSpaceFk: foreignKey({
      name: "v2_fk_proposals_target_space",
      columns: [table.targetSpaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
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
    spaceFk: foreignKey({
      name: "v2_fk_space_channels_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    channelFk: foreignKey({
      name: "v2_fk_space_channels_channel",
      columns: [table.channelId],
      foreignColumns: [userChannels.id],
    }).onDelete("restrict"),
    spaceIdx: index("v2_idx_space_channels_space").on(table.spaceId),
    idSpaceUniqueIdx: uniqueIndex("v2_uq_space_channels_id_space").on(table.id, table.spaceId),
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
    lastMessageId: uuid("last_message_id").references(
      (): AnyPgColumn => sessionMessages.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceFk: foreignKey({
      name: "v2_fk_space_sessions_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    spaceIdx: index("v2_idx_space_sessions_space_id").on(table.spaceId),
    idSpaceUniqueIdx: uniqueIndex("v2_uq_space_sessions_id_space").on(table.id, table.spaceId),
    userUuidIdx: index("v2_idx_space_sessions_user_uuid").on(table.userUuid),
    lastMessageIdx: index("v2_idx_space_sessions_last_message_id").on(table.lastMessageId),
    lastMessageAtIdx: index("v2_idx_space_sessions_last_message_at").on(table.lastMessageAt),
    titleSearchIdx: index("v2_idx_space_sessions_title_trgm").using("gin", table.title.op("gin_trgm_ops")),
    latestMessageTextSearchIdx: index("v2_idx_space_sessions_latest_message_text_trgm").using("gin", table.latestMessageText.op("gin_trgm_ops")),
    spaceLastMessageIdx: index("v2_idx_space_sessions_space_last_message_id").on(
      table.spaceId,
      table.lastMessageAt.desc().nullsLast(),
      table.id.desc(),
    ),
    // Speeds up /me/sessions creator branch: user_uuid + activity order.
    userLastMessageIdx: index("v2_idx_space_sessions_user_last_message").on(
      table.userUuid,
      table.lastMessageAt.desc().nullsLast(),
      table.id.desc(),
    ),
    // Speeds up participant membership: meta.participants.userUuids ? userUuid.
    participantUserUuidsIdx: index("v2_idx_space_sessions_participant_user_uuids").using(
      "gin",
      sql`(${table.meta} -> 'participants' -> 'userUuids')`,
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
    anchorTurnId: uuid("anchor_turn_id").notNull().references(
      (): AnyPgColumn => sessionTurns.id,
      { onDelete: "no action" },
    ),
    anchorSequence: integer("anchor_sequence").notNull(),
    ancestorSessionIds: uuid("ancestor_session_ids").array().notNull(),
    sessionPath: uuid("session_path").array().notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    spaceFk: foreignKey({
      name: "v2_fk_session_forks_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    parentSessionFk: foreignKey({
      name: "v2_fk_session_forks_parent_session",
      columns: [table.parentSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("no action"),
    childSessionFk: foreignKey({
      name: "v2_fk_session_forks_child_session",
      columns: [table.childSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("cascade"),
    rootSessionFk: foreignKey({
      name: "v2_fk_session_forks_root_session",
      columns: [table.rootSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("no action"),
    anchorSourceSessionFk: foreignKey({
      name: "v2_fk_session_forks_anchor_source_session",
      columns: [table.anchorSourceSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("no action"),
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
    sessionFk: foreignKey({
      name: "v2_fk_session_turn_segments_session",
      columns: [table.sessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("cascade"),
    sourceSessionFk: foreignKey({
      name: "v2_fk_session_turn_segments_source_session",
      columns: [table.sourceSessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("no action"),
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
    sessionSpaceFk: foreignKey({
      name: "v2_fk_space_session_bindings_session_space",
      columns: [table.spaceSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("cascade"),
    channelSpaceFk: foreignKey({
      name: "v2_fk_space_session_bindings_channel_space",
      columns: [table.spaceChannelId, table.spaceId],
      foreignColumns: [spaceChannels.id, spaceChannels.spaceId],
    }).onDelete("cascade"),
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
    sessionMessageId: uuid("session_message_id").references(
      (): AnyPgColumn => sessionMessages.id,
      { onDelete: "set null" },
    ),
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
    sessionSpaceFk: foreignKey({
      name: "v2_fk_provider_message_refs_session_space",
      columns: [table.spaceSessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("cascade"),
    spaceChannelFk: foreignKey({
      name: "v2_fk_provider_message_refs_space_channel",
      columns: [table.spaceChannelId],
      foreignColumns: [spaceChannels.id],
    }).onDelete("set null"),
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
    sessionFk: foreignKey({
      name: "v2_fk_session_turns_session",
      columns: [table.sessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("cascade"),
    sessionIdx: index("v2_idx_session_turns_session_id").on(table.sessionId),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_turns_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    userUuidIdx: index("v2_idx_session_turns_user_uuid").on(table.userUuid),
    createdAtIdx: index("v2_idx_session_turns_created_at").on(table.createdAt),
    userTextSearchIdx: index("v2_idx_session_turns_user_text_trgm").using("gin", table.userText.op("gin_trgm_ops")),
    sequenceCheck: check("v2_chk_session_turns_sequence", sql`${table.sequence} > 0`),
  }),
);

export const allocateSessionMessageSequence = (sessionId: string) =>
  sql<number>`v2.allocate_session_message_sequence(${sessionId}::uuid)`;

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
    usageAggregatedAt: timestamp("usage_aggregated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionFk: foreignKey({
      name: "v2_fk_session_messages_session",
      columns: [table.sessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("cascade"),
    sessionIdx: index("v2_idx_session_messages_session_id").on(table.sessionId),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_messages_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    idempotencyKeyUniqueIdx: uniqueIndex("v2_uq_session_messages_session_id_idempotency_key").on(
      table.sessionId,
      table.idempotencyKey,
    ),
    sequenceCheck: check("v2_chk_session_messages_sequence", sql`${table.sequence} > 0`),
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
    pk: unique("v2_uq_token_usage_stats_hourly_bucket_dims").on(
      table.bucketStartAt,
      table.userId,
      table.spaceId,
      table.sessionId,
      table.provider,
      table.model,
    ).nullsNotDistinct(),
    bucketIdx: index("v2_idx_token_usage_stats_hourly_bucket").on(table.bucketStartAt),
    userBucketIdx: index("v2_idx_token_usage_stats_hourly_user_bucket").on(table.userId, table.bucketStartAt),
    spaceBucketIdx: index("v2_idx_token_usage_stats_hourly_space_bucket").on(table.spaceId, table.bucketStartAt),
    sessionBucketIdx: index("v2_idx_token_usage_stats_hourly_session_bucket").on(table.sessionId, table.bucketStartAt),
    providerModelBucketIdx: index("v2_idx_token_usage_stats_hourly_provider_model_bucket").on(table.provider, table.model, table.bucketStartAt),
  }),
);

/**
 * Hourly multimodal generation usage rollups.
 * Mirrors token_usage_stats_hourly shape for trending / usage aggregation, but
 * dimensions on usageType instead of token breakdowns.
 *
 * Dimension notes:
 * - `sessionId` uses the zero UUID when a generation has no session context.
 * - `userId` / `provider` / `model` are NOT NULL with sentinels so the unique
 *   index and ON CONFLICT upserts stay reliable (Postgres NULLs are not equal).
 * - `provider` stores the generation **adapter type** (e.g. `openai.images`),
 *   not an LLM provider id — multimodal routing has no separate provider field.
 */
export const generationUsageStatsHourly = v2.table(
  "generation_usage_stats_hourly",
  {
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    spaceId: uuid("space_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    usageType: varchar("usage_type", { length: 100 }).notNull(),
    /** Generation adapter type, e.g. `openai.images` / `ark.videoGenerations`. */
    provider: varchar("provider", { length: 100 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    costTotal: numeric("cost_total", { precision: 18, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("v2_uq_generation_usage_stats_hourly_bucket_dims").on(
      table.bucketStartAt,
      table.userId,
      table.spaceId,
      table.sessionId,
      table.usageType,
      table.provider,
      table.model,
    ),
    bucketIdx: index("v2_idx_generation_usage_stats_hourly_bucket").on(table.bucketStartAt),
    userBucketIdx: index("v2_idx_generation_usage_stats_hourly_user_bucket").on(table.userId, table.bucketStartAt),
    spaceBucketIdx: index("v2_idx_generation_usage_stats_hourly_space_bucket").on(table.spaceId, table.bucketStartAt),
    sessionBucketIdx: index("v2_idx_generation_usage_stats_hourly_session_bucket").on(table.sessionId, table.bucketStartAt),
    usageTypeBucketIdx: index("v2_idx_generation_usage_stats_hourly_usage_type_bucket").on(table.usageType, table.bucketStartAt),
    providerModelBucketIdx: index("v2_idx_generation_usage_stats_hourly_provider_model_bucket").on(table.provider, table.model, table.bucketStartAt),
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

export const referralCodes = v2.table(
  "referral_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    status: varchar("status", { length: 20 }).$type<ReferralCodeStatus>().notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUniqueIdx: uniqueIndex("v2_uq_referral_codes_code").on(table.code),
    activeUserUniqueIdx: uniqueIndex("v2_uq_referral_codes_active_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    userIdx: index("v2_idx_referral_codes_user").on(table.userId),
  }),
);

export const referrals = v2.table(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referralCodeId: uuid("referral_code_id").notNull(),
    inviterUserId: varchar("inviter_user_id", { length: 255 }).notNull(),
    inviteeUserId: varchar("invitee_user_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).$type<ReferralStatus>().notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    inviterRewardedAt: timestamp("inviter_rewarded_at", { withTimezone: true }),
    inviteeRewardedAt: timestamp("invitee_rewarded_at", { withTimezone: true }),
    inviterRewardAmountUsd: numeric("inviter_reward_amount_usd", { precision: 12, scale: 8 }).notNull(),
    inviteeRewardAmountUsd: numeric("invitee_reward_amount_usd", { precision: 12, scale: 8 }).notNull(),
    rewardError: text("reward_error"),
    rewardAttemptedAt: timestamp("reward_attempted_at", { withTimezone: true }),
    rewardLeaseToken: varchar("reward_lease_token", { length: 64 }),
    rewardLeaseExpiresAt: timestamp("reward_lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    referralCodeFk: foreignKey({
      name: "v2_fk_referrals_referral_code",
      columns: [table.referralCodeId],
      foreignColumns: [referralCodes.id],
    }).onDelete("restrict"),
    inviteeUniqueIdx: uniqueIndex("v2_uq_referrals_invitee").on(table.inviteeUserId),
    inviterIdx: index("v2_idx_referrals_inviter").on(table.inviterUserId),
    codeIdx: index("v2_idx_referrals_code").on(table.referralCodeId),
    qualifiedRetryIdx: index("v2_idx_referrals_qualified_retry")
      .on(table.rewardAttemptedAt)
      .where(sql`${table.status} = 'qualified'`),
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
    spaceFk: foreignKey({
      name: "v2_fk_space_members_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
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
    spaceFk: foreignKey({
      name: "v2_fk_space_marks_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
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
    parentFk: foreignKey({
      name: "v2_fk_labels_parent",
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    idScopeUniqueIdx: uniqueIndex("v2_uq_labels_id_scope").on(
      table.id,
      table.scopeType,
      table.scopeId,
    ),
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
    rank: integer("rank"),
    source: varchar("source", { length: 30 }).notNull().default("user"),
    createdBy: varchar("created_by", { length: 255 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    labelScopeFk: foreignKey({
      name: "v2_fk_label_assignments_label_scope",
      columns: [table.labelId, table.scopeType, table.scopeId],
      foreignColumns: [labels.id, labels.scopeType, labels.scopeId],
    }).onDelete("cascade"),
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
    sessionLabelResourceIdx: index("v2_idx_label_assignments_session_label_resource").on(
      table.labelId,
      table.resourceRef,
    ).where(sql`${table.resourceType} = 'session'`),
    resourceLabelIdx: index("v2_idx_label_assignments_resource_label").on(
      table.resourceType,
      table.resourceRef,
      table.labelId,
    ),
    resourceRefSearchIdx: index("v2_idx_label_assignments_resource_ref_trgm").using("gin", table.resourceRef.op("gin_trgm_ops")),
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
    spaceFk: foreignKey({
      name: "v2_fk_cron_jobs_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("restrict"),
    sessionFk: foreignKey({
      name: "v2_fk_cron_jobs_session",
      columns: [table.sessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("restrict"),
    sessionSpaceFk: foreignKey({
      name: "v2_fk_cron_jobs_session_space",
      columns: [table.sessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }),
    sessionContextCheck: check(
      "v2_chk_cron_jobs_session_context",
      sql`${table.sessionId} IS NULL OR ${table.spaceId} IS NOT NULL`,
    ),
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
    cronJobFk: foreignKey({
      name: "v2_fk_task_runs_cron_job",
      columns: [table.cronJobId],
      foreignColumns: [cronJobs.id],
    }).onDelete("set null"),
    spaceFk: foreignKey({
      name: "v2_fk_task_runs_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("set null"),
    sessionFk: foreignKey({
      name: "v2_fk_task_runs_session",
      columns: [table.sessionId],
      foreignColumns: [spaceSessions.id],
    }).onDelete("set null"),
    turnFk: foreignKey({
      name: "v2_fk_task_runs_turn",
      columns: [table.turnId],
      foreignColumns: [sessionTurns.id],
    }).onDelete("set null"),
    jobIdUniqueIdx: uniqueIndex("v2_uq_task_runs_job_id").on(table.jobId),
    cronJobIdx: index("v2_idx_task_runs_cron_job_id").on(table.cronJobId),
    spaceIdx: index("v2_idx_task_runs_space_id").on(table.spaceId),
    sessionIdx: index("v2_idx_task_runs_session_id").on(table.sessionId),
    turnIdx: index("v2_idx_task_runs_turn_id").on(table.turnId),
    sessionTurnIdx: index("v2_idx_task_runs_session_turn").on(table.sessionId, table.turnId),
    userIdx: index("v2_idx_task_runs_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_task_runs_status").on(table.status),
    taskTypeIdx: index("v2_idx_task_runs_task_type").on(table.taskType),
    spaceSessionTypeStatusCreatedIdx: index("v2_idx_task_runs_space_session_type_status_created").on(
      table.spaceId,
      table.sessionId,
      table.taskType,
      table.status,
      table.createdAt,
      table.id,
    ),
    userSessionTypeStatusCreatedIdx: index("v2_idx_task_runs_user_session_type_status_created").on(
      table.userUuid,
      table.sessionId,
      table.taskType,
      table.status,
      table.createdAt,
      table.id,
    ),
    cronJobStatusCreatedIdx: index("v2_idx_task_runs_cron_job_status_created").on(
      table.cronJobId,
      table.status,
      table.createdAt,
      table.id,
    ),
    createdAtIdx: index("v2_idx_task_runs_created_at").on(table.createdAt),
    scheduledAtIdx: index("v2_idx_task_runs_scheduled_at").on(table.scheduledAt),
  }),
);

/**
 * Unified index of references between resources — the raw material behind
 * relationship stats (collaboration networks, lineage, influence rankings).
 *
 * Each row is a distinct reference observed within a single turn (or a
 * structural event without a turn, e.g. a fork or mod mount). `count` records
 * how many times the reference appeared within that turn; cross-turn totals are
 * derived at query time via SUM/COUNT.
 *
 * Source tables (session_turns, session_forks, checkpoints, space_mods, ...)
 * remain the sole source of truth. This table is a rebuildable index: it is
 * written by non-blocking double-writes at each behavior point and can be fully
 * reconstructed by a backfill scan at any time.
 */
export const resourceReferences = v2.table(
  "resource_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 30 }).$type<ReferenceKind>().notNull(),
    sourceType: varchar("source_type", { length: 20 }).$type<ReferenceResourceType>().notNull(),
    sourceId: text("source_id").notNull(),
    /** Turn where the reference occurred; null for structural references (fork/mod). */
    sourceTurnId: uuid("source_turn_id"),
    targetType: varchar("target_type", { length: 20 }).$type<ReferenceResourceType>().notNull(),
    targetId: text("target_id").notNull(),
    /** Owning space, for authorization and space-level aggregation. */
    spaceId: uuid("space_id").notNull(),
    /** Session the reference belongs to, when applicable. */
    sessionId: uuid("session_id"),
    /** Times this reference appeared within the source turn (usually 1). */
    count: integer("count").notNull().default(1),
    /** Denormalized context: mention label, tool name, fork anchor, etc. */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    spaceFk: foreignKey({
      name: "v2_fk_resource_references_space",
      columns: [table.spaceId],
      foreignColumns: [spaces.id],
    }).onDelete("cascade"),
    sessionSpaceFk: foreignKey({
      name: "v2_fk_resource_references_session",
      columns: [table.sessionId, table.spaceId],
      foreignColumns: [spaceSessions.id, spaceSessions.spaceId],
    }).onDelete("cascade"),
    sourceTurnFk: foreignKey({
      name: "v2_fk_resource_references_source_turn",
      columns: [table.sourceTurnId],
      foreignColumns: [sessionTurns.id],
    }).onDelete("cascade"),
    // Identity of a reference. `nullsNotDistinct` makes null turn ids compare
    // equal so structural references (fork/mod, turn-less) also get a stable
    // uniqueness key, while a plain-column target keeps upserts simple.
    uniqueReference: unique("v2_uq_resource_references_identity")
      .on(
        table.kind,
        table.sourceType,
        table.sourceId,
        table.sourceTurnId,
        table.targetType,
        table.targetId,
      )
      .nullsNotDistinct(),
    // "Who references me" reverse lookup (influence / dependents).
    targetIdx: index("v2_idx_resource_references_target").on(
      table.targetType,
      table.targetId,
      table.kind,
    ),
    // "What do I reference" forward lookup.
    sourceIdx: index("v2_idx_resource_references_source").on(
      table.sourceType,
      table.sourceId,
      table.kind,
    ),
    // Space-level aggregation and time trends.
    spaceKindIdx: index("v2_idx_resource_references_space_kind").on(
      table.spaceId,
      table.kind,
      table.updatedAt,
    ),
    // Session-level relationships.
    sessionKindIdx: index("v2_idx_resource_references_session_kind").on(
      table.sessionId,
      table.kind,
    ),
    // Backfill / turn-level rebuild.
    turnIdx: index("v2_idx_resource_references_turn").on(table.sourceTurnId),
  }),
);
