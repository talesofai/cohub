export { CohubHttpClient, createHttpClient } from "./http.js";
export { BillingApi } from "./apis/billing.js";
export { CohubClient, createCohubClient } from "./client.js";
export { WebsocketClient, createWebsocketClient } from "./websocket.js";
export { VoiceApi, VoiceInputClient, createVoiceInputClient } from "./voice-input.js";
export { UsersApi } from "./apis/users.js";
export { WorksApi } from "./apis/works.js";
export { UiCommandsApi } from "./apis/ui-commands.js";
export type { CreateUiCommandInput, WaitForUiCommandOptions } from "./apis/ui-commands.js";
export { WorkSurfaceApi } from "./work-surface.js";
export type { WorkSurfaceHandler, WorkSurfaceHandlerContext } from "./work-surface.js";
export {
  formatWorkRef,
  isWorkId,
  parseWorkRef,
  WorkRefParseError,
} from "./work-ref.js";
export type { ParsedWorkRef, WorkPublicRef } from "./work-ref.js";
export { WorkCommerceApi } from "./apis/work-commerce.js";
export { WorkRealtimeApi, WorkRoom } from "./apis/work-realtime.js";
export { ReferencesApi } from "./apis/references.js";
export { ReferralsApi } from "./apis/referrals.js";
export { buildSpaceInvitePath, buildSpacePath } from "./apis/invitations.js";
export type { BuildSpaceInvitePathInput, BuildSpacePathInput } from "./apis/invitations.js";
export type { ReferenceResourceSelector } from "./apis/references.js";
export { ParentBridgeTransport, PopupBrokerTransport, WorkRuntimeApi, createSlugWorkIdResolver, createWorkRuntime, resolveWorkTransport } from "./work-runtime.js";
export type { WorkIdResolver, WorkRuntimeModeConfig, WorkRuntimeRequestOptions, WorkRuntimeTransport } from "./work-runtime.js";
export { createWorkBridgeCore } from "./work-bridge-core.js";
export type { WorkBridgeCore, WorkBridgeCoreConfig, WorkBridgeCoreWork, WorkBridgeDialogState, WorkAuthorizeRequest, WorkPurchaseRequest, WorkBridgeGetAccessToken, WorkBridgeGetViewerUuid, WorkBridgeRequestSignIn } from "./work-bridge-core.js";
export { clearGrantedWorkScopes, hasGrantedWorkScopes, setGrantedWorkScopes } from "./work-grant-cache.js";
export { SessionPatchReducer, createSessionPatchReducer } from "./session-patch-reducer.js";
export {
  SessionGenerationStreamClient,
  createSessionGenerationStreamClient,
  parseAssistantMessageCommit,
} from "./session-generation-stream.js";
export {
  BILLING_ACCESS_BLOCKED_ERROR_CODE,
  FEATURE_NOT_ENTITLED_ERROR_CODE,
  extractBillingPayload,
  isBillingAccessBlockedCode,
  isBillingAccessBlockedError,
  isFeatureNotEntitledError,
  isHttpErrorCode,
} from "./http-error.js";
export { HttpError, joinApiUrl, matchesUnauthorizedErrorToken, sanitizeAccessToken } from "./transport.js";
export {
  COHUB_SOURCE_HEADER,
  COHUB_SOURCE_HEADER_NAMES,
  hasRequestSourceIdentity,
  isRequestSourceClientId,
  isRequestSourceEmpty,
  isRequestSourceUuid,
  mergeRequestSourceIntoMeta,
  normalizeRequestSource,
  parseRequestSourceFromHeaders,
  readRequestSourceFromEnv,
  REQUEST_SOURCE_VIA_MAX_LENGTH,
  requestSourceToHeaders,
  resolveRequestSourceChannel,
} from "@cohub/protocol/provenance";
export type { RequestSource, RequestSourceVia } from "@cohub/protocol/provenance";
export {
  GenerationPolicyError,
  assertGenerationRequestAllowedByPolicy,
  decodeGenerationPolicy,
  encodeGenerationPolicy,
  filterDiscoverableGenerationModels,
  filterGenerationDeclarationsByPolicy,
  findGenerationModelPolicy,
  getAllowedGenerationModelIds,
  isGenerationModelHidden,
  normalizeGenerationPolicy,
  parseGenerationPolicyFromEnv,
} from "@cohub/protocol/generation";
export type {
  GenerationModelPolicy,
  GenerationModelVisibility,
  GenerationParameterConstraint,
  GenerationPolicy,
  GenerationUsageBilling,
} from "@cohub/protocol/generation";
export type { RawHttpResponse } from "./transport.js";
export {
  COHUB_ENVIRONMENTS,
  normalizeBaseUrl,
  normalizeVoiceInputWebsocketUrl,
  normalizeWebsocketUrl,
  resolveApiBaseUrl,
  resolveCohubEnvironment,
  resolveVoiceInputWebsocketUrl,
  resolveWebsocketUrl,
} from "./environment.js";
export type { CohubClientOptions, Fetch, HttpTraceContext, UnauthorizedContext } from "./transport.js";
export type { CohubEnvironment } from "./environment.js";
export type {
  VoiceInputCallbacks,
  VoiceInputClientOptions,
  VoiceInputCreateOptions,
  VoiceInputEvent,
} from "./voice-input.js";
export type {
  SessionPatchApplyInput,
  SessionPatchApplyResult,
  SessionPatchState,
  SessionPatchStatus,
} from "./session-patch-reducer.js";
export type {
  AssistantMessageCommit,
  GenerationStreamCommitEvent,
  GenerationStreamErrorEvent,
  GenerationStreamEvent,
  GenerationStreamFinalizedEvent,
  GenerationStreamIntermediateMessage,
  GenerationStreamLifecycleEvent,
  GenerationStreamOutOfSyncEvent,
  GenerationStreamStateEvent,
  GenerationStreamSubscribeOptions,
  GenerationStreamSubscriptionHandlers,
  GenerationStreamTurnUpdatedEvent,
} from "./session-generation-stream.js";
export * from "./types.js";
export type {
  BoardAwarenessGesture,
  BoardAwarenessNodePreview,
  BoardAwarenessStateUpdate,
  BoardAwarenessUpdate,
  ChannelEnvelope,
  LabelAssignmentsUpdatedEvent,
  RealtimeServerEvent,
  RealtimeWorkRecord,
  RealtimeWorkVersionRecord,
  WorkVersionPublishedEvent,
} from "@cohub/protocol/realtime";
export type {
  BoardAwarenessUpdatedEvent,
  BoardEventName,
  BoardPlaybackChangedEvent,
  BoardSubscriptionHandlers,
  BoardTransactionAppliedEvent,
  BoardTransactionInput,
  SessionEventName,
  SessionSubscriptionHandlers,
  SpaceChannelBindingRecord,
  SpaceEventName,
  SpaceTurnListOptions,
  WebSocketConnectionState,
} from "./apis/spaces.js";
export type {
  RealtimeRoomDescriptor,
  RealtimeRoomEvent,
  RealtimeRoomMember,
} from "@cohub/protocol/realtime";
export type {
  WorkRoomAdmissionResponse,
  WorkRoomCreateInput,
  WorkRoomEvent,
  WorkRoomEventMap,
  WorkRoomPublishResult,
  WorkRoomState,
} from "./apis/work-realtime.js";
export { BoardClient, BoardTransactionError } from "./apis/spaces.js";
export {
  BoardPlaybackPolicySchema,
  parseBoardPlaybackPolicy,
} from "@cohub/protocol";
export * from "./board/animation.js";
export type { CreatePublicAssetUploadInput, CreatePublicAssetUploadResponse, PublicAssetMimeType, PublicAssetPurpose, PublicAssetUploadProgress, PublicAssetUploadProtocol, UploadChatAttachmentInput, UploadChatImageAttachmentInput, UploadPublicAssetInput } from "./apis/public-assets.js";
export type { WorkAuthorizeResponse, WorkContent, WorkContentDownload, WorkCreateInput, WorkDetailResponse, WorkExtractedPageMeta, WorkGetResponse, WorkMeta, WorkPresentationMeta, WorkPublicOwnerRecord, WorkPublicSpaceRecord, WorkRecord, WorkResolveResponse, WorkSessionResponse, WorkStatus, WorkTargetType, WorkUpdateInput, WorkVersionRecord, WorkViewSource, WorkViewStatsResponse, WorkVisibility } from "./apis/works.js";
export type { WorkArtifactDescriptor, WorkArtifactDownloadDescriptor, WorkArtifactManifest, WorkArtifactManifestFile, WorkBoardArtifactManifest, WorkBoardAsset, WorkContentKind } from "@cohub/protocol";
export {
  isTerminalUiCommandStatus,
  isUiSurfaceMethod,
  parseUiCommand,
  UI_COMMAND_DEFAULT_TIMEOUT_MS,
  UI_COMMAND_MAX_TIMEOUT_MS,
  UI_COMMAND_PAYLOAD_MAX_BYTES,
  UI_COMMAND_PENDING_TTL_SECONDS,
  UI_COMMAND_SETTLEMENT_GRACE_SECONDS,
  UI_COMMAND_TERMINAL_TTL_SECONDS,
  UI_COMMAND_VERSION,
} from "@cohub/protocol/ui-command";
export type {
  UiCommand,
  UiCommandDispatchedPayload,
  UiCommandError,
  UiCommandRecord,
  UiCommandStatus,
  UiPreviewShowCommand,
  UiPreviewTarget,
  UiSurfaceRequest,
  UiWorkPreviewTarget,
} from "@cohub/protocol/ui-command";
export {
  buildWorkSurfaceRequest,
  parseWorkSurfaceReady,
  parseWorkSurfaceResponse,
  WORK_COMPOSER_CHIP_CONTENT_MAX_BYTES,
  WORK_COMPOSER_CHIP_KEY_MAX_LENGTH,
  WORK_COMPOSER_CHIP_LABEL_MAX_LENGTH,
  WORK_SURFACE_READY_TIMEOUT_MS,
  WORK_SURFACE_REQUEST_TIMEOUT_MS,
} from "@cohub/protocol/work-surface";
export type {
  WorkComposerChip,
  WorkSurfaceReadyMessage,
  WorkSurfaceResponseMessage,
} from "@cohub/protocol/work-surface";
export type { WorkCommerceCheckoutStatus, WorkCommerceCreditConsumeResponse, WorkCommerceCreditConsumeStatus, WorkCommerceEntitlement, WorkCommerceEntitlementsResponse, WorkCommerceOrder, WorkCommerceProductResolveResponse, WorkCommercePurchaseResponse } from "./apis/work-commerce.js";
export type { WorkRuntimeCheckoutState, WorkRuntimeCheckoutStatus, WorkRuntimeContext } from "./work-runtime.js";
