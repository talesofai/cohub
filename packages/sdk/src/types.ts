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

export type PublicUserProfile = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type BatchUserProfilesResponse = {
  profiles: Record<string, PublicUserProfile>;
  missingUserUuids: string[];
};

export type SpacePresenceUser = {
  userId: string;
  connectionCount: number;
  lastSeenAt: string;
  meta: Record<string, unknown> | null;
  metas: Record<string, unknown>[];
  profile: PublicUserProfile;
};

export type SpacePresenceSnapshot = {
  spaceId: string;
  users: SpacePresenceUser[];
  updatedAt: string;
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
  benefitName: string | null;
  grantKind: string | null;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  availableNow: boolean | null;
  unavailableReasons: string[];
  remainingAmount: number;
  remainingAmountUsd: number;
  originalAmount: number | null;
  originalAmountUsd: number | null;
  consumedAmount: number | null;
  consumedAmountUsd: number | null;
  usageConsumedAmount: number | null;
  usageConsumedAmountUsd: number | null;
  settledOverageAmount: number | null;
  settledOverageAmountUsd: number | null;
  consumedPercent: number | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  createdAt: string;
};

export type BillingCreditExpiryGroup = {
  key: "expired" | "lt_7d" | "lt_30d" | "gte_30d" | "never";
  remainingAmountUsd: number;
  grants: BillingCreditGrantStatus[];
};

export type BillingCreditStatus = {
  netUsd: number;
  groups: BillingCreditExpiryGroup[];
};

export type BillingProductKind = "plan" | "addon";

export type BillingProductBillingInterval =
  | "monthly"
  | "quarterly"
  | "yearly"
  | "one_time"
  | "other";

export type BillingProductPricing = {
  amountMinor: number;
  amountUsd: number;
  compareAtAmountMinor: number | null;
  compareAtAmountUsd: number | null;
  discountLabel: string | null;
  discountRate: number | null;
};

export type BillingProductDisplay = {
  description: string | null;
  benefits: string[];
  creditsAmount: number | null;
  validity: string | null;
  creditBenefits: BillingProductCreditBenefit[];
};

export type BillingProductCreditBenefit = {
  key: string;
  name: string;
  tokenType: string;
  grantKind: string;
  scope: string;
  cycleAmount: number;
  cycleAmountUsd: number;
  periodAmount: number;
  periodAmountUsd: number;
  expiresInDays: number | null;
};

export type BillingCatalogProduct = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billingType: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currency: string;
  kind: BillingProductKind;
  interval: BillingProductBillingInterval;
  pricing: BillingProductPricing;
  display: BillingProductDisplay;
  isDefaultPlan: boolean;
};

export type SpaceCommerceFeatureBenefit = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  type: "feature";
  config: { type: "feature"; metadata: Record<string, string | number | boolean> };
};

export type SpaceCommerceCreditsBenefit = {
  key: string;
  name: string;
  description: string | null;
  status: string;
  type: "credits";
  config: { type: "credits"; amount: number; expiresInDays: number | null };
};

export type SpaceCommerceBenefit = SpaceCommerceFeatureBenefit | SpaceCommerceCreditsBenefit;

export type SpaceCommerceProductCreditBenefit = {
  key: string;
  name: string;
  amount: number;
  expiresInDays: number | null;
};

export type SpaceCommerceProduct = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  billingType: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currency: string;
  kind: "addon";
  interval: "one_time";
  pricing: {
    amountMinor: number;
    amountUsd: number;
    compareAtAmountMinor: number | null;
    compareAtAmountUsd: number | null;
    discountLabel: string | null;
    discountRate: number | null;
  };
  display: {
    description: string | null;
    benefits: string[];
    creditsAmount: number | null;
    validity: string | null;
    creditBenefits: SpaceCommerceProductCreditBenefit[];
  };
  isDefaultPlan: boolean;
};

export type SpaceCommerceProductBenefitBinding = {
  id: string | null;
  productKey: string;
  benefitKey: string;
  createdAt: string | null;
};

export type SpaceCommerceBuyerProfile = {
  displayName: string;
  avatarUrl: string | null;
};

export type SpaceCommerceOrder = {
  id: string;
  productKeySnapshot: string;
  productNameSnapshot: string;
  status: string;
  amountSnapshot: number;
  paidAmountSnapshot: number;
  createdAt: string;
  paidAt: string | null;
  buyerProfile: SpaceCommerceBuyerProfile | null;
};

export type BillingSubscriptionSummary = {
  id: string;
  productKey: string | null;
  productName: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingPaymentStatus = {
  available: boolean;
  reason: string | null;
};

export type BillingCatalog = {
  userId: string;
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  products: BillingCatalogProduct[];
  plans: BillingCatalogProduct[];
  addons: BillingCatalogProduct[];
  currentSubscriptions: BillingSubscriptionSummary[];
  hasActiveSubscription: boolean;
  defaultPlanProductKey: string | null;
};

export type BillingHistoryPagination = {
  hasMore: boolean;
  nextPage: number | null;
};

export type BillingCheckoutActionState = {
  canPay: boolean;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  canCancelCheckout: boolean;
  canCancelAutoRenew: boolean;
  unavailableReason: string | null;
};

export type BillingSubscriptionHistoryStatus = {
  id: string;
  externalUserId: string;
  productKey: string;
  productName: string;
  status: string;
  amountMinor: number;
  amountUsd: number;
  paidAmountMinor: number;
  paidAmountUsd: number;
  currency: string;
  billingPeriod: string;
  billingIntervalCount: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  checkoutExpiresAt: string | null;
  checkoutCanceledAt: string | null;
  checkoutExpiredAt: string | null;
  paymentConflictedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  providerStatus: string | null;
  providerTerminal: boolean;
  checkoutStatus: string | null;
  actions: BillingCheckoutActionState;
};

export type BillingSubscriptionHistoryList = {
  userId: string;
  billing: BillingPluginStatus;
  page: number;
  limit: number;
  items: BillingSubscriptionHistoryStatus[];
  pagination: BillingHistoryPagination;
};

export type BillingCheckoutResult = {
  userId: string;
  billing: BillingPluginStatus;
  payment: BillingPaymentStatus;
  productKey: string;
  checkoutUrl: string | null;
  checkoutUsable: boolean;
  message: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  reused: boolean;
};

export type BillingRedemptionResult = {
  userId: string;
  billing: BillingPluginStatus;
  redeemed: boolean;
  message: string | null;
  redemptionRecordId: string | null;
  itemCount: number;
};

export type BillingConversionIntent = {
  level: "soft" | "hard";
  reason:
    | "negative_balance"
    | "negative_balance_limit_exceeded"
    | "feature_not_entitled";
  audience: "free" | "paid" | "unknown";
  preferredOfferKind: "plan" | "upgrade" | "addon" | "mixed";
  title: string;
  message: string;
  primaryAction: {
    label: string;
    action: "open_billing_conversion";
  };
  source: string;
};

export type BillingAccessWarning = {
  status: "allowed_with_debt";
  balanceState: "negative";
  netUsd: number;
  hardNegativeLimitUsd: number;
  conversion: BillingConversionIntent;
};

export type BillingBalanceActivityKind =
  | "grant"
  | "usage"
  | "refund"
  | "expire"
  | "revoke"
  | "adjust";

export type BillingBalanceActivityStatus = "covered" | "overage" | "partial" | null;

export type BillingBalanceActivity = {
  id: string;
  kind: BillingBalanceActivityKind;
  tokenType: string;
  title: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  operationId: string | null;
  amountUsd: number;
  status: BillingBalanceActivityStatus;
  createdAt: string;
};

export type BillingBalanceActivityList = {
  userId: string;
  billing: BillingPluginStatus;
  tokenType: string;
  unit: BillingCreditUnit;
  page: number;
  limit: number;
  items: BillingBalanceActivity[];
  pagination: BillingHistoryPagination;
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
  lastActivityAt?: string | null;
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
  | { type: "git_repo"; repoUrl?: string; ref?: string | null }
  | { type: "checkpoint"; checkpointId: string };

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

export type CanvasDocumentRecord = {
  id: string;
  spaceId: string;
  filePath: string;
  title: string;
  version: number;
  meta?: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
};

export type CanvasNodeRecord = {
  documentId: string;
  nodeId: string;
  type: string;
  parentId?: string | null;
  orderKey?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  refKind?: string | null;
  refPath?: string | null;
  refUrl?: string | null;
  view: Record<string, unknown>;
  style: Record<string, unknown>;
  animation: Record<string, unknown>;
  data: Record<string, unknown>;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
};

export type CanvasNodeInput = Omit<CanvasNodeRecord, "documentId" | "version" | "createdAt" | "updatedAt" | "deletedAt">;

export type CanvasSemanticOp = {
  opId?: string;
  type: "node.create" | "node.patch" | "node.delete";
  payload: Record<string, unknown>;
  inverse?: Record<string, unknown>;
};

export type CanvasTransactionInput = {
  txId: string;
  baseVersion?: number | null;
  clientId?: string | null;
  undoGroupId?: string | null;
  ops: CanvasSemanticOp[];
};

export type CanvasCreateInput = {
  path: string;
  title?: string;
  nodes?: CanvasNodeInput[];
};

export type CanvasBootstrapResponse = {
  document: CanvasDocumentRecord;
  nodes: CanvasNodeRecord[];
};

export type SpaceCreateResponse = {
  space: SpaceRecord;
  taskRunId: string;
};

export type SpaceDefaultResponse = {
  space: SpaceRecord | null;
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
  billing?: BillingAccessWarning | null;
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
    lifecycle?: {
      phase: "llm_call_started";
      llmRound: number;
      provider: string | null;
      model: string | null;
      at: string;
    } | null;
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
  scope: "platform" | "mod" | "user" | "project";
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

export type GlobalSearchType = "turn" | "session" | "space" | "label";

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
  matchedField: "userText" | "title" | "name" | "description" | "labelName" | "labelItemContent";
  href: string;
  score: number;
  textScore: number;
  recencyScore: number;
  typePriorityScore: number;
  membershipPriorityScore?: number;
  labelRef?: string | null;
  labelName?: string | null;
  labelResourceType?: LabelResourceType | null;
  labelResourceRef?: string | null;
  updatedAt: string | null;
  source: "remote";
};

export type GlobalSearchResponse = {
  items: GlobalSearchResult[];
  query: string;
  source: "remote";
  degraded?: boolean;
};

export type CreateSpaceSessionInput = {
  title?: string | null;
  source?: string | null;
  labelRefs?: string[];
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

export type PromptAccessMode = "read_only" | "full_access";

export type CreateSpacePromptInput = {
  sessionId?: string | null;
  title?: string | null;
  source?: string | null;
  content: ContentBlock[];
  model?: string | null;
  provider?: string | null;
  clientMessageId?: string | null;
  generationPolicy?: GenerationPolicy | null;
  intent?: "followup" | "steer" | "compact" | null;
  accessMode?: PromptAccessMode | null;
  env?: Record<string, string> | null;
  labelRefs?: string[];
  schedule?:
    | { mode?: "immediate" }
    | { mode: "delay"; delayMs: number }
    | { mode: "at"; sendAt: string }
    | { mode: "repeat"; cronExpression: string; timezone: string };
};

export type CreateSpacePromptResponse =
  | (SessionTurnResponse & { mode: "immediate" })
  | {
      mode: "delay" | "at";
      taskRunId: string;
      scheduledAt: string;
      sessionId: string | null;
    }
  | {
      mode: "repeat";
      cronJobId: string;
      nextRunAt: string;
      timezone: string;
      sessionId: string | null;
    };

export type CronJobPayload = Record<string, unknown>;

export type SendMessageCronJobPayload = CronJobPayload & {
  content: ContentBlock[];
  clientMessageId?: string;
  generationPolicy?: unknown;
  intent?: "followup" | "steer" | string;
  accessMode?: "read_only" | "full_access";
  env?: Record<string, string> | null;
  source?: string;
  sessionId?: string;
  title?: string;
  model?: string;
  provider?: string;
  labelIds?: string[];
};

export type CronJobUpdatePatch<TPayload extends CronJobPayload = CronJobPayload> = {
  title?: string;
  payload?: TPayload;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export type CursorPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

export type CronJobRecord<TPayload extends CronJobPayload = CronJobPayload> = {
  id: string;
  userUuid: string;
  userProfile?: UserProfile;
  title: string;
  taskType: string;
  payload: TPayload;
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
  userProfile?: UserProfile;
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
  rootCheckpointId?: string | null;
  forkCount: number;
  saveVersion?: number;
  meta?: Record<string, unknown> | null;
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

export type LabelScopeType = "space" | "user" | "org";

export type LabelSource = "user" | "system";

export type LabelResourceType = "session" | "checkpoint" | "file";

export type LabelRecord = {
  id: string;
  scopeType: LabelScopeType;
  scopeId: string;
  name: string;
  slug: string;
  parentId: string | null;
  depth: number;
  source: LabelSource;
  systemKey: string | null;
  rank: number;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LabelListItem = LabelRecord & {
  children?: LabelListItem[];
};

export type LabelAssignmentRecord = {
  id: string;
  labelId: string;
  scopeType: LabelScopeType;
  scopeId: string;
  resourceType: LabelResourceType;
  resourceRef: string;
  rank: number;
  source: LabelSource;
  createdBy: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LabelAssignmentListItem = LabelAssignmentRecord & {
  href: string;
  resource: {
    title: string;
    subtitle: string | null;
    status: string | null;
  } | null;
};

export type LabelAssignmentPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

export type PatchResourceLabelsInput = {
  addLabelRefs?: string[];
  removeLabelRefs?: string[];
};

export type ResourceLabelsResponse = {
  labels: LabelListItem[];
  assignments: LabelAssignmentRecord[];
};

export type PatchResourceLabelsResponse = ResourceLabelsResponse & {
  changed: boolean;
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
  avatarUrl: string | null;
  avatarAlt: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  category: string | null;
  tags: string[];
  saveCount: number;
  pinCount: number;
  forkCount: number;
  updatedAt: string | null;
  accessLabel: "public" | "sign-in-required" | "unknown";
  latestSaveLabel: string | null;
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
  | "space.label.view"
  | "space.label.manage"
  | "space.label.assign"
  | "session.view"
  | "session.edit"
  | "session.prompt.readonly"
  | "session.prompt.fullaccess"
  | "generation.create"
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
  | "mod.manage"
  | "user.space.list"
  | "user.session.list"
  | "user.usage.read";

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
