import type {
  SessionBindingRecord as ProtocolSessionBindingRecord,
  SessionRecord as ProtocolSessionRecord,
  SessionForkRecord,
  SessionTurnIndexItem,
  SessionTurnRecord,
  SessionTurnSegmentRecord,
} from "@cohub/protocol/model";
import type {
  ChannelConfig,
} from "@cohub/protocol/gateway/types";
import type {
  ContentBlock,
  Usage,
} from "@cohub/protocol/core";
import type {
  CreateGenerationTaskRequest,
  CreateGenerationTaskResponse,
  GenerationContentBlock,
  GenerationPolicy,
  GenerationTaskResult,
  ListGenerationModelsResponse,
  PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { MessageRecord } from "@cohub/protocol/model";

export type {
  ChannelConfig,
  DiscordChannelConfig,
} from "@cohub/protocol/gateway/types";

export type ApiError = {
  message: string;
};

export type UserProfile = {
  userUuid: string;
  logtoUserId?: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  syncedAt?: string;
};

export type MeResponse = {
  uuid: string;
  profile: UserProfile;
  email: string | null;
};

export type BillingPluginStatus = {
  provider: "disabled" | "talesofai";
  configured: boolean;
  reason?: string;
};

export type BillingCreditUnit = {
  tokenType: string;
  displayCurrency: "USD";
  displayUnit: string;
  unitToUsd: number;
  unitsPerUsd: number;
  usdDecimalPlaces: number;
};

export type BillingCreditGrantStatus = {
  id: string;
  tokenType: string;
  benefitKey: string | null;
  grantKind: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  remainingAmount: number;
  remainingAmountUsd: number;
  originalAmount: number | null;
  originalAmountUsd: number | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
};

export type BillingCreditExpiryGroup = {
  key: "expired" | "lt_7d" | "lt_30d" | "gte_30d" | "never";
  label: string;
  remainingAmountUsd: number;
  grants: BillingCreditGrantStatus[];
};

export type BillingOpenOverageStatus = {
  id: string;
  tokenType: string;
  usageType: string | null;
  sourceType: string;
  sourceId: string;
  operationId: string;
  originalAmountUsd: number;
  remainingAmountUsd: number;
  settledAmountUsd: number;
  status: string;
  reason: string | null;
  createdAt: string;
};

export type BillingCreditStatus = {
  userId: string;
  billing: BillingPluginStatus;
  tokenType: string;
  unit: BillingCreditUnit;
  balance: {
    availableUsd: number;
    openOverageUsd: number;
    netUsd: number;
  };
  overage: {
    hasOpenOverage: boolean;
    openAmountUsd: number;
    items: BillingOpenOverageStatus[];
  };
  groups: BillingCreditExpiryGroup[];
};

export type UserRulesResponse = {
  content: string;
  updatedAt: string | null;
  source: "config-space";
  path: string;
};

export type {
  ContentBlock,
  MessageRecord,
  SessionTurnRecord,
  SessionTurnIndexItem,
  SessionForkRecord,
  SessionTurnSegmentRecord,
  CreateGenerationTaskRequest,
  CreateGenerationTaskResponse,
  GenerationContentBlock,
  GenerationPolicy,
  GenerationTaskResult,
  ListGenerationModelsResponse,
  PublicGenerationDeclaration,
};

export type SpaceFsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

export type SpaceFsTreeResponse = { path: string; entries: SpaceFsEntry[] };
export type SpaceFsFileKind = "text" | "binary";
export type SpaceFsEncoding = "utf-8" | "base64";
export type SpaceFsFileResponse = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  kind: SpaceFsFileKind;
  encoding: SpaceFsEncoding;
  content: string;
  delivery?: "inline" | "url";
  url?: string;
};
export type SpaceFsReadFilesInput = {
  paths: string[];
};
export type SpaceFsReadFilesError = {
  path: string;
  code: string;
  message: string;
  status: number;
};
export type SpaceFsPreparingFile = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  retryAfterMs: number;
};
export type SpaceFsReadFilesResponse = {
  files: SpaceFsFileResponse[];
  preparing?: SpaceFsPreparingFile[];
  errors: SpaceFsReadFilesError[];
};
export type SpaceFsWriteFileInput = {
  path: string;
  content: string;
  encoding: SpaceFsEncoding;
};
export type SpaceFsMoveInput = { fromPath: string; toPath: string };
export type SpaceFsUploadEntry = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};
export type SpaceFsUploadError = {
  name: string;
  code: "file_too_large" | "name_invalid" | "path_invalid" | "write_failed" | "object_missing";
  message: string;
};
export type SpaceFsUploadResponse = {
  uploaded: SpaceFsUploadEntry[];
  errors: SpaceFsUploadError[];
};
export type SpaceFsUploadPlanEntryInput = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType?: string | null;
  lastModified?: number;
};
export type SpaceFsUploadDestination =
  | {
      kind: "workspace";
      targetDir?: string;
    }
  | {
      kind: "sandbox_tmp";
      sessionId: string;
    };
export type SpaceFsCreateUploadInput = {
  destination: SpaceFsUploadDestination;
  entries: SpaceFsUploadPlanEntryInput[];
};
export type SpaceFsUploadPlanEntry = {
  id: string;
  objectKey: string;
  uploadUrl: string;
  headers?: Record<string, string>;
};
export type SpaceFsCreateUploadResponse = {
  uploadId: string;
  expiresAt: string;
  entries: SpaceFsUploadPlanEntry[];
};
export type SpaceFsCompleteUploadInput = {
  entries: Array<{ id: string; etag?: string | null }>;
};
export type SpaceFsCompleteUploadResponse = {
  ok: true;
  uploaded: SpaceFsUploadEntry[];
};
export type SpaceFsUploadProgress = {
  phase: "queued" | "importing" | "done" | "failed";
  totalFiles: number;
  importedFiles: number;
  totalBytes: number;
  importedBytes: number;
  currentPath?: string;
  errors: SpaceFsUploadError[];
};


export type SessionBindingRecord = ProtocolSessionBindingRecord;

export type SessionRecord = ProtocolSessionRecord & {
  bindings?: SessionBindingRecord[];
  totalMessages?: number;
  totalToolCalls?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: string | number | null;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type SpaceSandboxAutoDestroyPolicy =
  | { mode: "idle"; ttlSeconds: number }
  | { mode: "never" };

export type SpaceSandboxConfig = {
  autoDestroy: SpaceSandboxAutoDestroyPolicy;
};

export type SpaceConfig = {
  sandbox?: SpaceSandboxConfig;
};

export type SpacePublicProfile = {
  avatarUrl: string | null;
};

export type SpaceMeta = JsonObject & {
  config?: SpaceConfig;
  extraEnv?: SpaceEnvInput[];
  publicProfile?: Partial<SpacePublicProfile> | null;
};

export type SpaceRecord = {
  id: string;
  userUuid: string;
  name: string | null;
  slug: string | null;
  description: string | null;
  storageRepoName?: string | null;
  baseCheckpointId?: string | null;
  headCheckpointId?: string | null;
  title: string | null;
  status: string | null;
  meta: SpaceMeta | null;
  publicProfile?: SpacePublicProfile;
  createdAt: string;
  updatedAt: string;
  channels?: {
    id: string;
    name: string | null;
    provider: string;
    status: string;
  }[];
  access?: SpaceAccess;
  accessLevel?: "minimal";
  ownerProfile?: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
};

export type SpaceBootstrapSource =
  | { type: "blank" }
  | { type: "git_repo"; repoUrl?: string; ref?: string | null };

export type SpaceConfigInput = {
  sandbox?: {
    autoDestroy?: SpaceSandboxAutoDestroyPolicy;
  };
};

export type CreateSpaceModInput = {
  modSpaceId: string;
  name?: string | null;
  mountSlug?: string | null;
  enabled?: boolean;
};

export type CreateSpaceInput = {
  name?: string;
  slug?: string | null;
  description?: string | null;
  source?: string;
  extraEnv?: SpaceEnvInput[];
  channelBindings?: SpaceChannelBindingInput[];
  mods?: CreateSpaceModInput[];
  bootstrapSource?: SpaceBootstrapSource;
  config?: SpaceConfigInput;
};

export type SpaceConfigResponse = {
  config: Required<Pick<SpaceConfig, "sandbox">>;
};

export type SpaceCreateResponse = {
  space: SpaceRecord;
  taskRunId: string;
};

export type SpaceListItem = SpaceRecord;

export type SessionMessagesResponse = {
  session: SessionRecord;
  messages: MessageRecord[];
};

export type SessionMessageResponse = {
  session: SessionRecord;
  message: MessageRecord;
};

export type SessionMessagesPaginatedResponse = {
  session: SessionRecord;
  messages: MessageRecord[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnsPaginatedResponse = {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnIndexResponse = {
  session: SessionRecord;
  turns: SessionTurnIndexItem[];
  hasMore: boolean;
  nextCursor: number | undefined;
};

export type SessionTurnWindowResponse = {
  session: SessionRecord;
  turns: SessionTurnRecord[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  oldestCursor: number | undefined;
  newestCursor: number | undefined;
  anchorSequence: number | undefined;
};

export type SessionTurnResponse = {
  session: SessionRecord;
  turn: SessionTurnRecord;
};

export type SessionTurnSignedUrlsResponse = {
  urls: Record<string, string>;
};

export type SessionTurnStreamSnapshotResponse = {
  snapshot: {
    version: 2;
    spaceId: string;
    sessionId: string;
    turnId: string | null;
    anchorUserMessageId: string | null;
    seq: number;
    current: {
      messageId: string | null;
      messageOrdinal: number | null;
      content: ContentBlock[];
      appendPath: string | null;
    };
    intermediateMessages: Array<{
      messageId: string | null;
      messageOrdinal: number | null;
      content: ContentBlock[];
      id?: string;
      sessionId?: string;
      role?: "user" | "assistant" | "system";
      text?: string | null;
      provider?: string | null;
      model?: string | null;
      stopReason?: string | null;
      errorMessage?: string | null;
      usage?: Usage | null;
      toolCallsObjectKey?: string | null;
      meta?: Record<string, unknown> | null;
      createdAt?: string;
    }>;
    updatedAt: number;
  } | null;
};

export type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

export type PromptTemplateCatalogEntry = {
  name: string;
  description: string;
  argumentHint?: string;
  category?: string;
  scope: "platform";
};

export type PromptTemplateCatalogResponse = {
  prompts: PromptTemplateCatalogEntry[];
};

export type Channel = {
  id: string;
  userUuid: string;
  provider: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  boundSpace: {
    id: string;
    title: string | null;
    status: string;
  } | null;
};

export type SpaceEnvInput = {
  name: string;
  value: string;
};

export type SpaceChannelBindingInput = {
  channelId: string;
  config?: ChannelConfig | null;
};

export type GlobalSearchType = "turn" | "session" | "space";

export type GlobalSearchResult = {
  type: GlobalSearchType;
  id: string;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  sequence: number | null;
  title: string;
  excerpt?: string | null;
  spaceName?: string | null;
  sessionTitle?: string | null;
  ownerProfile?: Pick<UserProfile, "userUuid" | "username" | "displayName" | "avatarUrl"> | null;
  spaceProfile?: SpacePublicProfile | null;
  matchedField: "userText" | "title" | "name" | "description";
  href: string;
  score: number;
  textScore: number;
  recencyScore: number;
  typePriorityScore: number;
  membershipPriorityScore?: number;
  updatedAt: string | null;
  source: "remote";
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
  query: string;
  source: "remote";
  degraded?: boolean;
};

export type SpaceSessionsResponse = {
  sessions: SessionRecord[];
  forks?: Array<SessionForkRecord & {
    firstUserTextAfterFork?: string | null;
    parentTitle?: string | null;
  }>;
  pageInfo?: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

export type CreateSpacePromptInput = {
  sessionId?: string | null;
  title?: string | null;
  content: ContentBlock[];
  model?: string | null;
  provider?: string | null;
  clientMessageId?: string | null;
  generationPolicy?: GenerationPolicy | null;
  schedule?:
    | { mode?: "immediate" }
    | { mode: "delay"; delayMs: number }
    | { mode: "at"; sendAt: string }
    | { mode: "repeat"; cronExpression: string; timezone: string };
};

export type CreateSpacePromptResponse =
  | {
      ok: true;
      mode: "immediate";
      sessionId: string;
      userMessageId: string;
      turnId: string;
    }
  | {
      ok: true;
      mode: "delay" | "at";
      taskRunId: string;
      scheduledAt: string;
      sessionId: string | null;
    }
  | {
      ok: true;
      mode: "repeat";
      cronJobId: string;
      nextRunAt: string;
      timezone: string;
      sessionId: string | null;
    };

export type CronJobRecord = {
  id: string;
  userUuid: string;
  userProfile?: UserProfile;
  title: string;
  taskType: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  bullJobKey: string;
  spaceId: string | null;
  sessionId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskRunDetailResponse = {
  run: TaskRunRecord;
  progress: unknown;
};

export type TaskRunRecord = {
  id: string;
  jobId: string;
  cronJobId: string | null;
  taskType: string;
  status: "pending" | "running" | "completed" | "failed";
  payload: unknown;
  result: unknown;
  errorMessage: string | null;
  attemptCount: number;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userUuid: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CheckpointRecord = {
  id: string;
  spaceId: string;
  commitHash: string;
  description: string;
  parentCheckpointId: string | null;
  forkCount: number;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type SpaceCheckpointDetailResponse = {
  checkpoint: CheckpointRecord;
};

// ─── RBAC types ───

export type SpaceRole = "host" | "builder" | "guest";

export type SpaceMember = {
  userId: string;
  role: SpaceRole;
  profile: UserProfile;
  createdAt: string;
  updatedAt: string;
};

export type SpaceMarkKind = "pin";

export type SpaceMarkResourceType = "session" | "checkpoint" | "file" | "space";

export type SpaceMarkRecord = {
  id: string;
  spaceId: string;
  kind: SpaceMarkKind;
  resourceType: SpaceMarkResourceType;
  resourceRef: string;
  label: string | null;
  rank: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SpaceMarkListItem = SpaceMarkRecord & {
  href: string;
  resource: {
    title: string;
    subtitle: string | null;
    status: string | null;
  } | null;
};


export type SpaceModListItem = {
  id: string;
  spaceId: string;
  modSpaceId: string;
  name: string | null;
  mountSlug: string;
  mountPath: string;
  enabled: boolean;
  sortOrder: number;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  modSpaceName: string | null;
  modSpaceDescription: string | null;
};

/**
 * Public-safe DTO for Explore spaces.
 * Only contains fields safe for unauthenticated product rendering.
 */
export type ExploreSpaceItem = {
  id: string;
  slug: string | null;
  title: string;
  summary: string | null;
  spaceUrl: string;
  coverUrl: string | null;
  coverAlt: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  category: string | null;
  tags: string[];
  skillCount: number;
  assetCount: number;
  forkCount: number;
  updatedAt: string | null;
  accessLabel: "public" | "sign-in-required" | "unknown";
  latestSignal: string | null;
};

export type ExploreSection = {
  key: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  spaces: ExploreSpaceItem[];
};

export type ExploreSpacesResponse = {
  sections: ExploreSection[];
  spaces: ExploreSpaceItem[];
};

export type Permission =
  | "space.view"
  | "space.edit"
  | "space.pin"
  | "session.view"
  | "session.edit"
  | "session.prompt.readonly"
  | "session.prompt.fullaccess"
  | "file.view"
  | "file.view.filtered"
  | "file.edit"
  | "checkpoint.view"
  | "checkpoint.edit"
  | "member.view"
  | "member.manage"
  | "channel.view"
  | "channel.manage"
  | "cronjob.view"
  | "cronjob.manage"
  | "taskrun.view"
  | "sandbox.view"
  | "sandbox.manage"
  | "mod.view"
  | "mod.manage";

export type SpaceAccess = {
  role: SpaceRole | null;
  permissions: Permission[];
};

export type SpaceAccessPolicy = {
  signed_in_user: SpaceRole | null;
  anonymous_user: SpaceRole | null;
};

export type SpaceUsageHourlyStat = {
  bucketStartAt: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  models: string[];
};

export type SpaceUsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
};

export type SpaceUsageResponse = {
  hourly: SpaceUsageHourlyStat[];
  summary: SpaceUsageSummary;
  days: number;
};

// ─── Invitation types ───

export type SpaceInvitation = {
  token: string;
  role: SpaceRole;
  status: "active" | "revoked" | "exhausted";
  useCount: number;
  maxUses: number | null;
  createdAt: string | null;
  expiresInSeconds: number | null;
};

export type CreateInvitationInput = {
  role?: SpaceRole;
  ttlSeconds?: number;
  maxUses?: number;
};

export type CreateInvitationResponse = {
  token: string;
  role: SpaceRole;
  expiresAt: string;
  maxUses: number | null;
};

export type InvitationDetail = {
  token: string;
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
  expiresInSeconds: number | null;
};

export type AcceptInvitationResponse = {
  ok: true;
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
};
