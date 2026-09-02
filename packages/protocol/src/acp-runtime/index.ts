import { z } from "zod";
import type { ContentBlock } from "../core/content.js";

export const LOCAL_ACP_RUNTIME_PROTOCOL_VERSION = 1 as const;

export const LocalAcpProviderSchema = z.enum(["pi", "codex", "claude_code"]);
export type LocalAcpProvider = z.infer<typeof LocalAcpProviderSchema>;

export const LocalAcpRuntimeStatusSchema = z.enum([
  "offline",
  "connecting",
  "ready",
  "busy",
  "error",
  "revoked",
]);
export type LocalAcpRuntimeStatus = z.infer<typeof LocalAcpRuntimeStatusSchema>;

export const LocalAcpRuntimeCapabilitiesSchema = z.object({
  sessionLoad: z.boolean().default(false),
  sessionResume: z.boolean().default(false),
  sessionCancel: z.boolean().default(true),
  permissionRequests: z.boolean().default(true),
  promptImage: z.boolean().default(false),
  nativeTools: z.boolean().default(true),
}).strict();
export type LocalAcpRuntimeCapabilities = z.infer<typeof LocalAcpRuntimeCapabilitiesSchema>;

export const LocalAcpRuntimeRegistrationSchema = z.object({
  version: z.literal(LOCAL_ACP_RUNTIME_PROTOCOL_VERSION),
  runtimeId: z.string().min(1),
  spaceId: z.string().min(1),
  replicaId: z.string().min(1),
  deviceId: z.string().min(1),
  provider: LocalAcpProviderSchema,
  providerVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  capabilities: LocalAcpRuntimeCapabilitiesSchema,
}).strict();
export type LocalAcpRuntimeRegistration = z.infer<typeof LocalAcpRuntimeRegistrationSchema>;

export const LocalAcpRuntimeCommandStatusSchema = z.enum([
  "prepared",
  "sent",
  "completed",
  "failed",
  "unknown",
]);
export type LocalAcpRuntimeCommandStatus = z.infer<typeof LocalAcpRuntimeCommandStatusSchema>;

export const LocalAcpRuntimeCommandSchema = z.object({
  version: z.literal(LOCAL_ACP_RUNTIME_PROTOCOL_VERSION),
  commandId: z.string().min(1),
  runtimeId: z.string().min(1),
  spaceId: z.string().min(1),
  cohubSessionId: z.string().min(1),
  executionAttemptId: z.string().min(1),
  cwd: z.string().min(1),
  provider: LocalAcpProviderSchema,
  model: z.string().min(1).nullable(),
  content: z.array(z.unknown()).min(1),
  accessMode: z.enum(["read_only", "full_access"]),
  connectionEpoch: z.number().int().positive(),
}).strict();
export type LocalAcpRuntimeCommand = z.infer<typeof LocalAcpRuntimeCommandSchema>;

export type LocalAcpRuntimeCommandRecord = {
  commandId: string;
  runtimeId: string;
  runtimeSessionId: string;
  executionAttemptId: string;
  method: string;
  sequence: number;
  status: LocalAcpRuntimeCommandStatus;
  paramsHash: string;
  response: Record<string, unknown> | null;
  errorMessage: string | null;
};

export type AcpJsonRpcId = string | number;

export type AcpJsonRpcRequest = {
  jsonrpc: "2.0";
  id: AcpJsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type AcpJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type AcpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: AcpJsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type AcpJsonRpcMessage = AcpJsonRpcRequest | AcpJsonRpcNotification | AcpJsonRpcResponse;

export type AcpSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type LocalAcpRuntimeSession = {
  runtimeId: string;
  cohubSessionId: string;
  acpSessionId: string;
  connectionEpoch: number;
  lastEventSequence: number;
  lastEventHash: string | null;
  status: "active" | "closed" | "disconnected" | "error" | "revoked";
};

export type LocalAcpRuntimeEventReceipt = {
  runtimeSessionId: string;
  eventId: string;
  sequence: number;
  method: string;
  payloadHash: string;
};

export const isAcpJsonRpcResponse = (value: AcpJsonRpcMessage): value is AcpJsonRpcResponse =>
  "id" in value && !("method" in value);

export const isAcpJsonRpcRequest = (value: AcpJsonRpcMessage): value is AcpJsonRpcRequest =>
  "id" in value && "method" in value;

export const isAcpJsonRpcNotification = (value: AcpJsonRpcMessage): value is AcpJsonRpcNotification =>
  !("id" in value) && "method" in value;

export const textContentBlocks = (value: string): ContentBlock[] => [{ type: "text", text: value }];
