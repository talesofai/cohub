import { createHash } from "node:crypto";

export type CanvasNodeInput = {
  nodeId: string;
  type: string;
  parentId?: string | null;
  orderKey?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  refKind?: string | null;
  refPath?: string | null;
  refUrl?: string | null;
  view?: Record<string, unknown>;
  style?: Record<string, unknown>;
  animation?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

export type CanvasSemanticOp = {
  opId?: string;
  version?: 1 | 2;
  type: "node.create" | "node.patch" | "node.data.merge" | "node.delete" | "document.meta.patch";
  payload: Record<string, unknown>;
  inverse?: Record<string, unknown>;
};

export class CanvasServiceError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "canvas_error",
    public currentVersion?: number,
  ) {
    super(message);
  }
}

export const MAX_CANVAS_NODES = 2000;
export const MAX_CANVAS_OPS = 100;
export const MAX_NODE_ID_LENGTH = 120;
export const MAX_NODE_TYPE_LENGTH = 40;
export const MAX_REF_LENGTH = 4096;
export const MAX_JSON_FIELD_BYTES = 16 * 1024;
export const MAX_TRANSACTION_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
const cleanRecord = (value: unknown, fieldName: string) => {
  if (value == null) return {};
  if (!isRecord(value)) throw new CanvasServiceError(400, `${fieldName} must be an object`);
  if (jsonBytes(value) > MAX_JSON_FIELD_BYTES) throw new CanvasServiceError(413, `${fieldName} is too large`);
  return value;
};
const finiteNumber = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optionalString = (value: unknown, fieldName: string, maxLength = MAX_REF_LENGTH) => {
  if (value == null) return null;
  if (typeof value !== "string") throw new CanvasServiceError(400, `${fieldName} must be a string`);
  if (value.length > maxLength) throw new CanvasServiceError(400, `${fieldName} is too long`);
  return value;
};

export function normalizeNode(input: CanvasNodeInput) {
  if (!input || typeof input.nodeId !== "string" || !input.nodeId.trim()) throw new CanvasServiceError(400, "nodeId is required");
  if (input.nodeId.length > MAX_NODE_ID_LENGTH) throw new CanvasServiceError(400, "nodeId is too long");
  if (typeof input.type !== "string" || !input.type.trim()) throw new CanvasServiceError(400, "node type is required");
  if (input.type.length > MAX_NODE_TYPE_LENGTH) throw new CanvasServiceError(400, "node type is too long");
  return {
    nodeId: input.nodeId.trim(),
    type: input.type.trim(),
    parentId: optionalString(input.parentId, "parentId"),
    orderKey: optionalString(input.orderKey, "orderKey"),
    x: finiteNumber(input.x, 0),
    y: finiteNumber(input.y, 0),
    width: Math.max(1, finiteNumber(input.width, 240)),
    height: Math.max(1, finiteNumber(input.height, 160)),
    rotation: finiteNumber(input.rotation, 0),
    refKind: optionalString(input.refKind, "refKind", 40),
    refPath: optionalString(input.refPath, "refPath"),
    refUrl: optionalString(input.refUrl, "refUrl"),
    view: cleanRecord(input.view, "view"),
    style: cleanRecord(input.style, "style"),
    animation: cleanRecord(input.animation, "animation"),
    data: cleanRecord(input.data, "data"),
  };
}

export function normalizeNodes(input: CanvasNodeInput[]) {
  if (input.length > MAX_CANVAS_NODES) throw new CanvasServiceError(413, "Too many canvas nodes");
  const nodes = input.map(normalizeNode);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.nodeId)) throw new CanvasServiceError(400, "nodeId must be unique");
    seen.add(node.nodeId);
  }
  return nodes;
}

export type NormalizedPatch = Partial<ReturnType<typeof normalizeNode>>;

function normalizePatch(input: Record<string, unknown>): NormalizedPatch {
  const patch: NormalizedPatch = {};
  if ("type" in input) {
    if (typeof input.type !== "string" || !input.type.trim()) throw new CanvasServiceError(400, "type must be a non-empty string");
    if (input.type.length > MAX_NODE_TYPE_LENGTH) throw new CanvasServiceError(400, "type is too long");
    patch.type = input.type.trim();
  }
  if ("parentId" in input) patch.parentId = optionalString(input.parentId, "parentId");
  if ("orderKey" in input) patch.orderKey = optionalString(input.orderKey, "orderKey");
  if ("x" in input) patch.x = finiteNumber(input.x, 0);
  if ("y" in input) patch.y = finiteNumber(input.y, 0);
  if ("width" in input) patch.width = Math.max(1, finiteNumber(input.width, 240));
  if ("height" in input) patch.height = Math.max(1, finiteNumber(input.height, 160));
  if ("rotation" in input) patch.rotation = finiteNumber(input.rotation, 0);
  if ("refKind" in input) patch.refKind = optionalString(input.refKind, "refKind", 40);
  if ("refPath" in input) patch.refPath = optionalString(input.refPath, "refPath");
  if ("refUrl" in input) patch.refUrl = optionalString(input.refUrl, "refUrl");
  if ("view" in input) patch.view = cleanRecord(input.view, "view");
  if ("style" in input) patch.style = cleanRecord(input.style, "style");
  if ("animation" in input) patch.animation = cleanRecord(input.animation, "animation");
  if ("data" in input) patch.data = cleanRecord(input.data, "data");
  if (Object.keys(patch).length === 0) throw new CanvasServiceError(400, "node.patch is empty");
  return patch;
}

function normalizeOp(op: CanvasSemanticOp): CanvasSemanticOp {
  if (!op || typeof op.type !== "string" || !isRecord(op.payload)) throw new CanvasServiceError(400, "invalid op");
  const version = op.version === 2 ? 2 : 1;
  if (op.type === "node.create") {
    const node = normalizeNode(op.payload.node as CanvasNodeInput);
    return { opId: optionalString(op.opId, "opId", 120) ?? undefined, version, type: "node.create", payload: { node }, inverse: isRecord(op.inverse) ? op.inverse : undefined };
  }
  if (op.type === "node.patch") {
    const nodeId = optionalString(op.payload.nodeId, "nodeId", MAX_NODE_ID_LENGTH);
    if (!nodeId) throw new CanvasServiceError(400, "node.patch requires nodeId");
    const patch = isRecord(op.payload.patch) ? normalizePatch(op.payload.patch) : null;
    if (!patch) throw new CanvasServiceError(400, "node.patch requires patch");
    return { opId: optionalString(op.opId, "opId", 120) ?? undefined, version, type: "node.patch", payload: { nodeId, patch }, inverse: isRecord(op.inverse) ? op.inverse : undefined };
  }
  if (op.type === "node.data.merge") {
    if (version !== 2) throw new CanvasServiceError(400, "node.data.merge requires operation version 2");
    const nodeId = optionalString(op.payload.nodeId, "nodeId", MAX_NODE_ID_LENGTH);
    if (!nodeId) throw new CanvasServiceError(400, "node.data.merge requires nodeId");
    const data = cleanRecord(op.payload.data, "data");
    if (Object.keys(data).length === 0) throw new CanvasServiceError(400, "node.data.merge is empty");
    return { opId: optionalString(op.opId, "opId", 120) ?? undefined, version, type: "node.data.merge", payload: { nodeId, data }, inverse: isRecord(op.inverse) ? op.inverse : undefined };
  }
  if (op.type === "node.delete") {
    const nodeId = optionalString(op.payload.nodeId, "nodeId", MAX_NODE_ID_LENGTH);
    if (!nodeId) throw new CanvasServiceError(400, "node.delete requires nodeId");
    return { opId: optionalString(op.opId, "opId", 120) ?? undefined, version, type: "node.delete", payload: { nodeId }, inverse: isRecord(op.inverse) ? op.inverse : undefined };
  }
  if (op.type === "document.meta.patch") {
    if (version !== 2) throw new CanvasServiceError(400, "document.meta.patch requires operation version 2");
    const patch = cleanRecord(op.payload.patch, "patch");
    if (Object.keys(patch).length === 0) throw new CanvasServiceError(400, "document.meta.patch is empty");
    return { opId: optionalString(op.opId, "opId", 120) ?? undefined, version, type: "document.meta.patch", payload: { patch }, inverse: isRecord(op.inverse) ? op.inverse : undefined };
  }
  throw new CanvasServiceError(400, "unsupported op type");
}

export function normalizeCanvasOps(ops: CanvasSemanticOp[]) {
  if (!ops.length) throw new CanvasServiceError(400, "ops are required");
  if (ops.length > MAX_CANVAS_OPS) throw new CanvasServiceError(413, "too many ops");
  if (jsonBytes(ops) > MAX_TRANSACTION_BYTES) throw new CanvasServiceError(413, "transaction is too large");
  const normalized = ops.map(normalizeOp);
  if (jsonBytes(normalized) > MAX_TRANSACTION_BYTES) throw new CanvasServiceError(413, "transaction is too large");
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canvasRequestHash(ops: CanvasSemanticOp[]) {
  return createHash("sha256").update(canonicalJson(ops)).digest("hex");
}

export function normalizeCanvasTransactionIdentity(input: { txId: string; baseVersion: number }) {
  const txId = optionalString(input.txId, "txId", 120)?.trim();
  if (!txId) throw new CanvasServiceError(400, "txId is required", "invalid_transaction");
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    throw new CanvasServiceError(400, "baseVersion must be a non-negative integer", "invalid_base_version");
  }
  return { txId, baseVersion: input.baseVersion };
}
