import { z } from "zod";
import { canonicalizeJson, canonicalizeJsonBytes, sha256Hex } from "../workspace-replication/index.js";

export const LOCAL_AGENT_PROTOCOL_VERSION = 1 as const;
export const NATIVE_TURN_BUNDLE_VERSION = 1 as const;
export const LOCAL_AGENT_INLINE_INGEST_MAX_BYTES = 128 * 1024;
export const LOCAL_AGENT_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const LOCAL_AGENT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;

export const NativeProviderSchema = z.enum(["pi", "codex", "claude_code"]);
export const LocalAgentDeviceStatusSchema = z.enum(["active", "revoked"]);
export type LocalAgentDeviceStatus = z.infer<typeof LocalAgentDeviceStatusSchema>;
export type NativeProvider = z.infer<typeof NativeProviderSchema>;
export const SessionMirrorModeSchema = z.enum(["full", "metadata_only", "disabled"]);
export type SessionMirrorMode = z.infer<typeof SessionMirrorModeSchema>;
export const MirrorFidelitySchema = z.enum(["exact", "history_reconciled", "hook_reconstructed"]);
export type MirrorFidelity = z.infer<typeof MirrorFidelitySchema>;
export const MirrorCompletenessSchema = z.enum(["complete", "truncated", "attachments_unavailable", "metadata_only"]);
export type MirrorCompleteness = z.infer<typeof MirrorCompletenessSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NullableStringSchema = z.string().nullable();
const PayloadSchema = z.record(z.string(), z.unknown());

export const LocalAgentHookTypeSchema = z.enum([
  "session_started",
  "prompt_submitted",
  "turn_started",
  "tool_started",
  "tool_finished",
  "message_finished",
  "turn_stopped",
  "turn_failed",
  "session_compacted",
  "session_ended",
  "provider_exited",
]);
export type LocalAgentHookType = z.infer<typeof LocalAgentHookTypeSchema>;

export const LocalAgentHookEnvelopeSchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  executionAttemptId: z.string().min(1).nullable(),
  eventId: z.string().min(1),
  observedAt: z.string().datetime({ offset: true }),
  deviceId: z.string().min(1),
  replicaId: z.string().min(1),
  provider: NativeProviderSchema,
  providerVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  identityKeyVersion: NonNegativeIntegerSchema,
  workspacePolicyVersion: NonNegativeIntegerSchema,
  integrationPolicyVersion: NonNegativeIntegerSchema,
  sessionMirrorMode: SessionMirrorModeSchema,
  nativeSessionKey: z.string().min(1),
  nativeTurnKey: z.string().min(1).nullable(),
  nativeEventSequence: NonNegativeIntegerSchema.nullable(),
  localReceiptSequence: NonNegativeIntegerSchema,
  type: LocalAgentHookTypeSchema,
  workspace: z.object({
    relativeCwd: z.string().min(1),
    baseCanonicalSnapshotId: z.string().min(1).nullable(),
    localSnapshotId: z.string().min(1).nullable(),
    leaseEpoch: NonNegativeIntegerSchema.nullable(),
  }).strict(),
  payload: PayloadSchema,
}).strict();

export type LocalAgentHookEnvelopeV1 = z.infer<typeof LocalAgentHookEnvelopeSchema>;

const PortableContentSchema = z.object({
  type: z.enum(["text", "thinking", "image"]),
  text: z.string().optional(),
  artifactKey: z.string().min(1).optional(),
  sha256: Sha256Schema.optional(),
  size: NonNegativeIntegerSchema.optional(),
}).strict();

const NativeToolCallSchema = z.object({
  nativeToolCallKey: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

export const SanitizedProviderHistoryEntrySchema = z.object({
  nativeMessageKey: z.string().min(1),
  role: z.enum(["user", "assistant", "tool_result", "compaction"]),
  content: z.array(PortableContentSchema),
  toolCalls: z.array(NativeToolCallSchema).optional(),
  nativeToolCallKey: z.string().min(1).optional(),
  nativeParentMessageKey: z.string().min(1).optional(),
  toolResult: z.object({
    isError: z.boolean(),
    content: z.array(PortableContentSchema),
  }).strict().optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  usage: z.record(z.string(), z.number().finite()).nullable().optional(),
}).strict();
export type SanitizedProviderHistoryEntryV1 = z.infer<typeof SanitizedProviderHistoryEntrySchema>;

export const NativeCursorSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type NativeProviderCursor = z.infer<typeof NativeCursorSchema>;

export const NativeTurnBundleSchema = z.object({
  version: z.literal(NATIVE_TURN_BUNDLE_VERSION),
  executionAttemptId: z.string().min(1),
  workspacePolicyVersion: NonNegativeIntegerSchema,
  integrationPolicyVersion: NonNegativeIntegerSchema,
  sessionMirrorMode: SessionMirrorModeSchema,
  bundleId: z.string().min(1),
  provider: NativeProviderSchema,
  providerVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  nativeSessionKey: z.string().min(1),
  nativeTurnKey: z.string().min(1),
  previousNativeCursor: NativeCursorSchema.nullable(),
  nextNativeCursor: NativeCursorSchema,
  cohubTranscriptBase: z.record(z.string(), z.unknown()).nullable(),
  workspaceExecutionBase: z.object({
    executionAttemptId: z.string().min(1),
    canonicalSnapshotId: z.string().min(1).nullable(),
    localSnapshotId: z.string().min(1).nullable(),
    leaseEpoch: NonNegativeIntegerSchema.nullable(),
  }).strict(),
  events: z.array(LocalAgentHookEnvelopeSchema),
  historyDelta: z.array(SanitizedProviderHistoryEntrySchema),
  fidelityHint: MirrorFidelitySchema,
  diagnostics: PayloadSchema,
}).strict();
export type NativeTurnBundleV1 = z.infer<typeof NativeTurnBundleSchema>;

export const NativeIngestStatusSchema = z.enum([
  "prepared",
  "uploaded",
  "verifying",
  "committed",
  "translating",
  "forking",
  "appending_jsonl",
  "projecting",
  "publishing_marker",
  "applied",
  "failed",
  "quarantined",
]);
export type NativeIngestStatus = z.infer<typeof NativeIngestStatusSchema>;

export const NativeIngestInlineRequestSchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  bindingId: z.string().min(1).nullable(),
  nativeAgentTurnId: z.string().min(1).nullable(),
  bundle: NativeTurnBundleSchema,
  payloadSha256: Sha256Schema,
}).strict();
export type NativeIngestInlineRequestV1 = z.infer<typeof NativeIngestInlineRequestSchema>;

export const NativeIngestPrepareRequestSchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  executionAttemptId: z.string().min(1),
  bindingId: z.string().min(1).nullable(),
  nativeAgentTurnId: z.string().min(1).nullable(),
  bundleId: z.string().min(1),
  payloadSha256: Sha256Schema,
  payloadBytes: NonNegativeIntegerSchema,
  provider: NativeProviderSchema,
  providerVersion: z.string().min(1).default("unknown"),
  adapterVersion: z.string().min(1).default("locald-hook-v1"),
  nativeSessionKey: z.string().min(1),
  nativeTurnKey: z.string().min(1),
  workspacePolicyVersion: NonNegativeIntegerSchema,
  integrationPolicyVersion: NonNegativeIntegerSchema,
  sessionMirrorMode: SessionMirrorModeSchema,
}).strict();
export type NativeIngestPrepareRequestV1 = z.infer<typeof NativeIngestPrepareRequestSchema>;

export const NativeIngestCommitResponseSchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  ingestId: z.string().min(1),
  uploadStatus: z.enum(["committed", "uploaded"]),
  semanticStatus: z.enum(["pending_verification", "ready", "applied", "quarantined"]),
  executionAttemptId: z.string().min(1),
  cohubSessionId: z.string().min(1).nullable(),
  cohubTurnId: z.string().min(1).nullable(),
  nextPollAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type NativeIngestCommitResponseV1 = z.infer<typeof NativeIngestCommitResponseSchema>;

export const LocalAgentPolicySchema = z.object({
  version: z.literal(LOCAL_AGENT_PROTOCOL_VERSION),
  sessionMirrorMode: SessionMirrorModeSchema,
  workspaceMode: z.enum(["two_way_safe", "one_way_to_cloud", "one_way_to_local", "handoff"]),
  offlineEnabled: z.boolean(),
  attachmentMode: z.enum(["workspace_only", "approved_external", "none"]),
  maxBundleBytes: NonNegativeIntegerSchema,
  maxArtifactBytes: NonNegativeIntegerSchema,
}).strict();
export type LocalAgentPolicyV1 = z.infer<typeof LocalAgentPolicySchema>;

/** Canonical bytes used for payload identity before transport compression. */
export const canonicalLocalAgentPayload = (value: unknown): Uint8Array => canonicalizeJsonBytes(value);
export const canonicalLocalAgentPayloadText = (value: unknown): string => canonicalizeJson(value);

export async function hashLocalAgentPayload(value: unknown): Promise<string> {
  return sha256Hex(canonicalLocalAgentPayload(value));
}

export function isMetadataOnlyBundle(bundle: Pick<NativeTurnBundleV1, "sessionMirrorMode" | "historyDelta">): boolean {
  return bundle.sessionMirrorMode === "metadata_only" || bundle.historyDelta.length === 0;
}

export function nativeIngestStatusIsTerminal(status: NativeIngestStatus): boolean {
  return status === "applied" || status === "failed" || status === "quarantined";
}

export function validateNativeTurnBundleSize(bundle: NativeTurnBundleV1): void {
  const bytes = canonicalLocalAgentPayload(bundle).byteLength;
  if (bytes > LOCAL_AGENT_MAX_BUNDLE_BYTES) {
    throw new Error(`native_bundle_too_large:${bytes}`);
  }
}

export function validateNativeTurnBundleInlineSize(bundle: NativeTurnBundleV1): void {
  const bytes = canonicalLocalAgentPayload(bundle).byteLength;
  if (bytes > LOCAL_AGENT_INLINE_INGEST_MAX_BYTES) {
    throw new Error(`native_inline_bundle_too_large:${bytes}`);
  }
}

export function validateLocalAgentHookEnvelope(value: unknown): LocalAgentHookEnvelopeV1 {
  const parsed = LocalAgentHookEnvelopeSchema.parse(value);
  const bytes = canonicalLocalAgentPayload(parsed).byteLength;
  if (bytes > LOCAL_AGENT_INLINE_INGEST_MAX_BYTES) throw new Error(`hook_payload_too_large:${bytes}`);
  return parsed;
}

export const nullableString = NullableStringSchema;
