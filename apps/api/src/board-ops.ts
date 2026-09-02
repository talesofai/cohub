import {
  BOARD_BUILTIN_CLIP_KINDS,
  BOARD_BUILTIN_EFFECT_KINDS,
  BOARD_NATIVE_NODE_TYPES,
  BoardCameraFocusParamsSchema,
  BoardEffectSchema,
  BoardNodeInputSchema,
  BoardPlaybackPolicySchema,
  DEFAULT_BOARD_RENDER_LIMITS,
  estimateBuiltinBoardClipCost,
  parseBoardCompositionInput,
  validateBuiltinBoardClip,
  validateBuiltinBoardEffect,
  type BoardProceduralClip,
  type BoardComposition,
  type BoardDiagnostic,
  type BoardEffect,
  type BoardNodeInput,
  type BoardOperation,
  type BoardRenderCost,
  type BoardTransaction,
  type BoardValidationResult,
  validateBoardNodeInput,
} from "@cohub/protocol";
import { BoardAppearanceSchema } from "@cohub/protocol/board-document";
import {
  BoardConnectionPatchSchema,
  BoardConnectionSchema,
  connectionItemIds,
  type BoardConnection,
  type BoardConnectionPatch,
} from "@cohub/protocol/board-connection";

export class BoardServiceError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public diagnostics?: BoardDiagnostic[],
  ) {
    super(message);
    this.name = "BoardServiceError";
  }
}

/**
 * Ceiling on nodes in a board, and on operations in one transaction.
 *
 * These two are deliberately equal. Any lower operation cap would create edits a
 * user can make but not save: selecting every node and deleting it is one
 * operation per node, and a transaction is one undo step, so the client cannot
 * split it without splitting undo and making a partial edit visible to everyone
 * else. So the invariant is: whatever you are allowed to create, you are allowed
 * to edit in one go.
 *
 * The real guard is MAX_TRANSACTION_BYTES below - an operation count says nothing
 * about cost, whereas bytes bound both the request and the work it implies.
 */
export const MAX_BOARD_NODES = 50_000;
/**
 * Ceiling on connections in a board.
 *
 * Equal to the node cap for the same reason it bounds operations: a fully
 * connected selection is a legitimate edit, and a lower relation cap would create
 * a board a user can draw but not save.
 */
export const MAX_BOARD_CONNECTIONS = 50_000;
export const MAX_BOARD_OPERATIONS = 50_000;
export const MAX_NODE_ID_LENGTH = 160;
export const MAX_NODE_TYPE_LENGTH = 40;
export const MAX_REF_LENGTH = 4096;
export const MAX_JSON_FIELD_BYTES = 64 * 1024;
/**
 * Ceiling on one transaction's JSON payload.
 *
 * Sized from the measured cost of the operations that actually reach this limit:
 * a delete or a geometry patch is ~110 B on the wire, so the worst realistic bulk
 * edit (touch all 50k nodes) is ~6 MB. Bulk *creates* are ~480 B each and come
 * through boards.create instead, bounded by MAX_NODES_BYTES.
 */
export const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
/**
 * Ceiling on the nodes array of one boards.create.
 *
 * A created node measures ~480 B, so 50k of them is ~23 MB; 32 MB leaves headroom
 * without letting a single request become unbounded.
 */
export const MAX_NODES_BYTES = 32 * 1024 * 1024;
/**
 * Rows per node INSERT/UPSERT statement.
 *
 * Postgres allows 65535 bind parameters per statement and a node row binds ~18, so
 * anything above ~3600 rows fails outright. 500 keeps a wide margin and bounds the
 * size of a single statement's parameter list.
 */
export const NODE_WRITE_CHUNK = 500;

const BUILTIN_CLIP_KINDS = new Set<string>(BOARD_BUILTIN_CLIP_KINDS);
const BUILTIN_EFFECT_KINDS = new Set<string>(BOARD_BUILTIN_EFFECT_KINDS);

export const ZERO_BOARD_COST: BoardRenderCost = {
  particles: 0,
  vertices: 0,
  dynamicVertices: 0,
  drawCalls: 0,
  filterPasses: 0,
  renderTexturePixels: 0,
  textureBytes: 0,
  bufferBytes: 0,
  simulationSteps: 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");

export function boardSchemaDiagnostics(
  error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] },
  code: string,
  prefix: string,
): BoardDiagnostic[] {
  return error.issues.slice(0, 32).map((issue) => ({
    severity: "error",
    code,
    message: issue.message,
    path: [prefix, ...issue.path].map(String).join("."),
  }));
}

function assertSafeJson(value: unknown, path: string): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertSafeJson(item, `${path}.${index}`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /^(?:glsl|wgsl|shaderSource|sourceCode)$/i.test(key)) {
      throw new BoardServiceError(400, `${path}.${key} is not allowed`, "UNTRUSTED_CODE");
    }
    assertSafeJson(item, `${path}.${key}`);
  }
}

function cleanRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) throw new BoardServiceError(400, `${fieldName} must be an object`);
  if (jsonBytes(value) > MAX_JSON_FIELD_BYTES) throw new BoardServiceError(413, `${fieldName} is too large`);
  assertSafeJson(value, fieldName);
  return value;
}

function cleanBoardMetadata(value: unknown): Record<string, unknown> {
  let metadata = cleanRecord(value, "board.metadata");
  if (metadata.playback !== undefined) {
    const parsed = BoardPlaybackPolicySchema.safeParse(metadata.playback);
    if (!parsed.success) {
      throw new BoardServiceError(
        400,
        parsed.error.issues[0]?.message ?? "invalid Board playback metadata",
        "INVALID_PLAYBACK_POLICY",
      );
    }
    metadata = { ...metadata, playback: parsed.data };
  }
  if (metadata.appearance !== undefined) {
    const parsed = BoardAppearanceSchema.safeParse(metadata.appearance);
    if (!parsed.success) {
      throw new BoardServiceError(
        400,
        parsed.error.issues[0]?.message ?? "invalid Board appearance metadata",
        "INVALID_BOARD_APPEARANCE",
      );
    }
    metadata = { ...metadata, appearance: parsed.data };
  }
  return metadata;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizePlaybackPosition(position: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.min(duration, Math.max(0, position));
}

function optionalString(value: unknown, fieldName: string, maxLength = MAX_REF_LENGTH): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new BoardServiceError(400, `${fieldName} must be a string`);
  const result = value.trim();
  if (result.length > maxLength) throw new BoardServiceError(400, `${fieldName} is too long`);
  return result || null;
}

export function normalizeNode(
  input: BoardNodeInput,
  path = "node",
  validateSemantics = true,
): BoardNodeInput {
  if (!isRecord(input) || typeof input.nodeId !== "string" || !input.nodeId.trim()) {
    throw new BoardServiceError(400, "nodeId is required");
  }
  if (input.nodeId.length > MAX_NODE_ID_LENGTH) throw new BoardServiceError(400, "nodeId is too long");
  if (typeof input.type !== "string" || !input.type.trim()) throw new BoardServiceError(400, "node type is required");
  if (input.type.length > MAX_NODE_TYPE_LENGTH) throw new BoardServiceError(400, "node type is too long");
  const diagnostics = validateSemantics
    ? (BOARD_NATIVE_NODE_TYPES as readonly string[]).includes(input.type)
      ? validateBoardNodeInput(input, path)
      : /^(?:extension\.)?[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(input.type) && BoardNodeInputSchema.safeParse(input).success
        ? []
        : [{
            severity: "error" as const,
            code: "INVALID_BOARD_NODE" as const,
            message: /^(?:extension\.)?[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(input.type)
              ? `${path}: invalid extension node envelope`
              : `${path}.type is not supported`,
            path: /^(?:extension\.)?[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(input.type)
              ? path
              : `${path}.type`,
          }]
    : [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new BoardServiceError(
      400,
      first?.message ?? "invalid Board node",
      first?.code ?? "INVALID_BOARD_NODE",
      diagnostics,
    );
  }
  const refUrl = optionalString(input.refUrl, "refUrl");
  if (refUrl && /^https?:\/\//i.test(refUrl)) {
    throw new BoardServiceError(400, "refUrl cannot contain a network URL", "UNTRUSTED_URL");
  }
  const node: BoardNodeInput = {
    nodeId: input.nodeId.trim(),
    type: input.type.trim(),
    parentId: optionalString(input.parentId, "parentId"),
    orderKey: optionalString(input.orderKey, "orderKey"),
    x: finite(input.x, 0),
    y: finite(input.y, 0),
    width: Math.max(1, finite(input.width, 240)),
    height: Math.max(1, finite(input.height, 160)),
    rotation: finite(input.rotation, 0),
    refKind: optionalString(input.refKind, "refKind", 40),
    refPath: optionalString(input.refPath, "refPath"),
    refUrl,
    view: cleanRecord(input.view, "view"),
    style: cleanRecord(input.style, "style"),
    data: cleanRecord(input.data, "data"),
  };
  return node;
}

export function normalizeNodes(input: BoardNodeInput[]): BoardNodeInput[] {
  if (!Array.isArray(input)) throw new BoardServiceError(400, "nodes must be an array");
  if (input.length > MAX_BOARD_NODES) throw new BoardServiceError(413, "too many board nodes");
  // Bounded by bytes as well as count, for the same reason transactions are: a node
  // carries free-form view/style/data, so a legal count says nothing about the size
  // of the request behind it.
  if (jsonBytes(input) > MAX_NODES_BYTES) throw new BoardServiceError(413, "board nodes are too large");
  const nodes = input.map((node, index) => normalizeNode(node, `nodes.${index}`));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.nodeId)) throw new BoardServiceError(400, `duplicate nodeId: ${node.nodeId}`);
    ids.add(node.nodeId);
  }
  return nodes;
}

export type NormalizedNodePatch = Partial<Omit<BoardNodeInput, "nodeId">>;

/**
 * Validate a connection through its schema.
 *
 * The schema is the single definition of a connection's shape, so this only adds
 * what a schema cannot express: the free-form metadata is screened for embedded
 * shader source, exactly as node and effect payloads are.
 */
export function normalizeConnection(input: unknown): BoardConnection {
  const parsed = BoardConnectionSchema.safeParse(input);
  if (!parsed.success) {
    throw new BoardServiceError(400, parsed.error.issues[0]?.message ?? "invalid board connection");
  }
  const connection = parsed.data;
  cleanRecord(connection.metadata, "connection.metadata");
  return connection;
}

export function normalizeConnections(input: unknown): BoardConnection[] {
  if (!Array.isArray(input)) throw new BoardServiceError(400, "connections must be an array");
  if (input.length > MAX_BOARD_CONNECTIONS) throw new BoardServiceError(413, "too many board connections");
  if (jsonBytes(input) > MAX_NODES_BYTES) throw new BoardServiceError(413, "board connections are too large");
  const connections = input.map(normalizeConnection);
  const ids = new Set<string>();
  for (const connection of connections) {
    if (ids.has(connection.id)) throw new BoardServiceError(400, `duplicate connectionId: ${connection.id}`);
    ids.add(connection.id);
  }
  return connections;
}

function normalizeConnectionPatch(input: unknown): BoardConnectionPatch {
  if (!isRecord(input)) throw new BoardServiceError(400, "connection.patch requires patch");
  const parsed = BoardConnectionPatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new BoardServiceError(400, parsed.error.issues[0]?.message ?? "invalid connection patch");
  }
  // A partial schema silently accepts unknown keys; rejecting them keeps a typo
  // from being stored as a no-op the author believes took effect.
  for (const key of Object.keys(input)) {
    if (!(key in parsed.data) && key !== "id") {
      throw new BoardServiceError(400, `unsupported connection patch field: ${key}`);
    }
  }
  if (Object.keys(parsed.data).length === 0) throw new BoardServiceError(400, "connection.patch is empty");
  if (parsed.data.metadata) cleanRecord(parsed.data.metadata, "connection.metadata");
  return parsed.data;
}

function normalizeNodePatch(input: unknown): NormalizedNodePatch {
  if (!isRecord(input)) throw new BoardServiceError(400, "node.patch requires patch");
  const sentinel: BoardNodeInput = {
    nodeId: "patch",
    type: typeof input.type === "string" ? input.type : "patch",
    parentId: input.parentId as string | null,
    orderKey: input.orderKey as string | null,
    x: input.x as number,
    y: input.y as number,
    width: input.width as number,
    height: input.height as number,
    rotation: input.rotation as number,
    refKind: input.refKind as string | null,
    refPath: input.refPath as string | null,
    refUrl: input.refUrl as string | null,
    view: input.view as Record<string, unknown>,
    style: input.style as Record<string, unknown>,
    data: input.data as Record<string, unknown>,
  };
  const normalized = normalizeNode(sentinel, "patch", false);
  const patch: NormalizedNodePatch = {};
  for (const key of Object.keys(input)) {
    if (key === "nodeId" || !(key in normalized)) throw new BoardServiceError(400, `unsupported node patch field: ${key}`);
    (patch as Record<string, unknown>)[key] = normalized[key as keyof BoardNodeInput];
  }
  if (Object.keys(patch).length === 0) throw new BoardServiceError(400, "node.patch is empty");
  return patch;
}

function cameraFocusNodeIds(clip: Pick<BoardProceduralClip, "kind" | "params">): string[] {
  if (clip.kind !== "camera.focus") return [];
  const parsed = BoardCameraFocusParamsSchema.safeParse(clip.params);
  if (!parsed.success) return [];
  const focus = parsed.data.focus;
  if (focus.type === "item") return [focus.itemId];
  if (focus.type === "frame") return [focus.frameId];
  return focus.type === "items" ? focus.itemIds : [];
}

function parseEffect(value: unknown) {
  const parsed = BoardEffectSchema.omit({ boardId: true, revision: true }).safeParse(value);
  if (!parsed.success) {
    throw new BoardServiceError(
      400,
      "Board effect is invalid.",
      "INVALID_BOARD_EFFECT",
      boardSchemaDiagnostics(parsed.error, "INVALID_BOARD_EFFECT", "effect"),
    );
  }
  assertSafeJson(parsed.data.params, "effect.params");
  assertSafeJson(parsed.data.metadata, "effect.metadata");
  for (const ref of parsed.data.assetRefs) {
    if (ref.type === "extension" && !ref.digest) throw new BoardServiceError(400, "extension assets require a digest");
  }
  const [diagnostic] = validateBuiltinBoardEffect(parsed.data);
  if (diagnostic) throw new BoardServiceError(400, diagnostic.message, diagnostic.code, [diagnostic]);
  return parsed.data;
}

function parseComposition(value: unknown): Omit<BoardComposition, "revision"> {
  if (jsonBytes(value) > MAX_TRANSACTION_BYTES) {
    throw new BoardServiceError(413, "composition is too large");
  }
  let composition: Omit<BoardComposition, "revision">;
  try {
    composition = parseBoardCompositionInput(value);
  } catch (error) {
    const diagnostics = error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? boardSchemaDiagnostics(error as { issues: { path: PropertyKey[]; message: string }[] }, "INVALID_COMPOSITION", "composition")
      : undefined;
    throw new BoardServiceError(
      400,
      diagnostics?.[0]?.message ?? (error instanceof Error ? error.message : "Board composition is invalid."),
      "INVALID_COMPOSITION",
      diagnostics,
    );
  }
  assertSafeJson(composition.metadata, "composition.metadata");
  for (const [index, marker] of composition.timeline.markers.entries()) {
    assertSafeJson(marker.metadata, `composition.timeline.markers.${index}.metadata`);
  }
  for (const [index, track] of composition.timeline.tracks.entries()) {
    assertSafeJson(track.metadata, `composition.timeline.tracks.${index}.metadata`);
    for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
      assertSafeJson(keyframe.value, `composition.timeline.tracks.${index}.keyframes.${keyframeIndex}.value`);
    }
  }
  for (const [index, clip] of composition.timeline.clips.entries()) {
    assertSafeJson(clip.params, `composition.timeline.clips.${index}.params`);
    assertSafeJson(clip.metadata, `composition.timeline.clips.${index}.metadata`);
    for (const ref of clip.assetRefs) {
      if (ref.type === "extension" && !ref.digest) {
        throw new BoardServiceError(400, `composition.timeline.clips.${index}: extension assets require a digest`);
      }
    }
    const [diagnostic] = validateBuiltinBoardClip(clip, `composition.timeline.clips.${index}`);
    if (diagnostic) throw new BoardServiceError(400, diagnostic.message, diagnostic.code, [diagnostic]);
  }
  const cameraFocusClips = composition.timeline.clips
    .filter((clip) => clip.kind === "camera.focus")
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < cameraFocusClips.length; index += 1) {
    const previous = cameraFocusClips[index - 1];
    const current = cameraFocusClips[index];
    if (previous && current && current.start < previous.start + previous.duration) {
      throw new BoardServiceError(400, "camera.focus clips must not overlap");
    }
  }
  return composition;
}

export function normalizeBoardOperation(operation: BoardOperation): BoardOperation {
  if (!isRecord(operation) || typeof operation.type !== "string" || !isRecord(operation.payload)) {
    throw new BoardServiceError(400, "invalid board operation");
  }
  const opId = optionalString(operation.opId, "opId", 160) ?? undefined;
  const base = opId ? { opId } : {};
  switch (operation.type) {
    case "board.patch": {
      if (!isRecord(operation.payload.patch)) throw new BoardServiceError(400, "board.patch requires patch");
      const patch: { title?: string; metadata?: Record<string, unknown>; metadataPatch?: Record<string, unknown> } = {};
      if ("title" in operation.payload.patch) {
        if (typeof operation.payload.patch.title !== "string" || !operation.payload.patch.title.trim()) throw new BoardServiceError(400, "board title is required");
        patch.title = operation.payload.patch.title.trim().slice(0, 255);
      }
      if ("metadata" in operation.payload.patch) patch.metadata = cleanBoardMetadata(operation.payload.patch.metadata);
      if ("metadataPatch" in operation.payload.patch) patch.metadataPatch = cleanBoardMetadata(operation.payload.patch.metadataPatch);
      if (Object.keys(patch).length === 0) throw new BoardServiceError(400, "board.patch is empty");
      return { ...base, type: "board.patch", payload: { patch } };
    }
    case "node.create":
      return {
        ...base,
        type: "node.create",
        payload: {
          node: normalizeNode(
            operation.payload.node as BoardNodeInput,
            "payload.node",
          ),
        },
      };
    case "node.patch": {
      const nodeId = optionalString(operation.payload.nodeId, "nodeId", MAX_NODE_ID_LENGTH);
      if (!nodeId) throw new BoardServiceError(400, "node.patch requires nodeId");
      return { ...base, type: "node.patch", payload: { nodeId, patch: normalizeNodePatch(operation.payload.patch) } };
    }
    case "node.delete": {
      const nodeId = optionalString(operation.payload.nodeId, "nodeId", MAX_NODE_ID_LENGTH);
      if (!nodeId) throw new BoardServiceError(400, "node.delete requires nodeId");
      const reason = optionalString(operation.payload.reason, "reason", 80) ?? undefined;
      return { ...base, type: "node.delete", payload: { nodeId, ...(reason ? { reason } : {}) } };
    }
    case "connection.create":
      return {
        ...base,
        type: "connection.create",
        payload: { connection: normalizeConnection(operation.payload.connection) },
      };
    case "connection.patch": {
      const connectionId = optionalString(operation.payload.connectionId, "connectionId", MAX_NODE_ID_LENGTH);
      if (!connectionId) throw new BoardServiceError(400, "connection.patch requires connectionId");
      return {
        ...base,
        type: "connection.patch",
        payload: { connectionId, patch: normalizeConnectionPatch(operation.payload.patch) },
      };
    }
    case "connection.delete": {
      const connectionId = optionalString(operation.payload.connectionId, "connectionId", MAX_NODE_ID_LENGTH);
      if (!connectionId) throw new BoardServiceError(400, "connection.delete requires connectionId");
      const reason = optionalString(operation.payload.reason, "reason", 80) ?? undefined;
      return {
        ...base,
        type: "connection.delete",
        payload: { connectionId, ...(reason ? { reason } : {}) },
      };
    }
    case "effect.upsert":
      return { ...base, type: "effect.upsert", payload: { effect: parseEffect(operation.payload.effect) } };
    case "effect.delete": {
      const effectId = optionalString(operation.payload.effectId, "effectId", 160);
      if (!effectId) throw new BoardServiceError(400, "effect.delete requires effectId");
      return { ...base, type: "effect.delete", payload: { effectId } };
    }
    case "composition.apply":
      return {
        ...base,
        type: "composition.apply",
        payload: { composition: parseComposition(operation.payload.composition) },
      };
    case "composition.delete": {
      const compositionId = optionalString(operation.payload.compositionId, "compositionId", 160);
      if (!compositionId) throw new BoardServiceError(400, "composition.delete requires compositionId");
      return { ...base, type: "composition.delete", payload: { compositionId } };
    }
  }
  throw new BoardServiceError(400, "unsupported board operation");
}

export function normalizeBoardTransaction(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): BoardTransaction {
  if (!isRecord(value)) throw new BoardServiceError(400, "invalid board transaction");
  if (jsonBytes(value) > MAX_TRANSACTION_BYTES) throw new BoardServiceError(413, "transaction is too large");
  const txId = optionalString(value.txId, "txId", 160);
  const boardId = optionalString(value.boardId, "boardId", 160);
  if (!txId || !boardId) throw new BoardServiceError(400, "txId and boardId are required");
  if (!Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 0) throw new BoardServiceError(400, "baseVersion must be a non-negative integer");
  if (!Array.isArray(value.operations) || (!options.allowEmpty && value.operations.length === 0)) {
    throw new BoardServiceError(400, "operations are required");
  }
  if (value.operations.length > MAX_BOARD_OPERATIONS) throw new BoardServiceError(413, "too many operations");
  return {
    txId,
    boardId,
    baseVersion: value.baseVersion as number,
    clientId: optionalString(value.clientId, "clientId", 160),
    undoGroupId: optionalString(value.undoGroupId, "undoGroupId", 160),
    operations: value.operations.map((operation) => normalizeBoardOperation(operation as BoardOperation)),
  };
}

function addCost(target: BoardRenderCost, source: Partial<BoardRenderCost>, multiplier = 1): void {
  for (const key of Object.keys(target) as Array<keyof BoardRenderCost>) {
    target[key] += (source[key] ?? 0) * multiplier;
  }
}

function compositionPeakCost(composition: Omit<BoardComposition, "revision">): BoardRenderCost {
  const clips = composition.timeline.clips;
  const events: Array<{ at: number; direction: 1 | -1; cost: BoardRenderCost }> = [];
  for (const clip of clips) {
    const cost = { ...ZERO_BOARD_COST };
    addCost(cost, estimateBuiltinBoardClipCost(clip));
    events.push({ at: clip.start, direction: 1, cost });
    events.push({ at: clip.start + clip.duration, direction: -1, cost });
  }
  events.sort((left, right) => left.at - right.at || left.direction - right.direction);
  const current = { ...ZERO_BOARD_COST };
  const peak = { ...ZERO_BOARD_COST };
  for (const event of events) {
    addCost(current, event.cost, event.direction);
    for (const key of Object.keys(peak) as Array<keyof BoardRenderCost>) peak[key] = Math.max(peak[key], current[key]);
  }
  return peak;
}

export type BoardValidationContext = {
  boardVersion: number;
  nodeIds: Iterable<string>;
  /** Full records for nodes patched by this transaction. */
  nodes?: Iterable<BoardNodeInput>;
  /** Existing connections, so deletes and patches can be checked in order. */
  connections: Iterable<Pick<BoardConnection, "id" | "source" | "target">>;
  effects: Iterable<Pick<BoardEffect, "id" | "target">>;
  compositions: Iterable<BoardComposition>;
  metadata?: Record<string, unknown>;
};

export function structuralValidation(transaction: BoardTransaction): BoardValidationResult {
  const diagnostics: BoardDiagnostic[] = [];
  const peakCost = { ...ZERO_BOARD_COST };
  for (const [index, operation] of transaction.operations.entries()) {
    if (operation.type === "effect.upsert") {
      if (!BUILTIN_EFFECT_KINDS.has(operation.payload.effect.kind)) {
        diagnostics.push({
          severity: "warning",
          code: "UNKNOWN_EFFECT",
          message: `No built-in renderer is registered for ${operation.payload.effect.kind}@${operation.payload.effect.kindVersion}`,
          path: `operations.${index}.payload.effect`,
        });
      }
      continue;
    }
    if (operation.type !== "composition.apply") continue;
    for (const [clipIndex, clip] of operation.payload.composition.timeline.clips.entries()) {
      if (!BUILTIN_CLIP_KINDS.has(clip.kind)) {
        diagnostics.push({
          severity: "warning",
          code: "UNKNOWN_CLIP",
          message: `No built-in renderer is registered for ${clip.kind}@${clip.kindVersion}`,
          path: `operations.${index}.payload.composition.timeline.clips.${clipIndex}`,
        });
      }
    }
    const compositionCost = compositionPeakCost(operation.payload.composition);
    compositionCost.simulationSteps += operation.payload.composition.timeline.tracks.reduce(
      (total, track) => total + track.keyframes.length,
      0,
    );
    for (const key of Object.keys(peakCost) as Array<keyof BoardRenderCost>) peakCost[key] = Math.max(peakCost[key], compositionCost[key]);
  }
  for (const key of Object.keys(DEFAULT_BOARD_RENDER_LIMITS) as Array<keyof BoardRenderCost>) {
    if (peakCost[key] <= DEFAULT_BOARD_RENDER_LIMITS[key]) continue;
    diagnostics.push({
      severity: "warning",
      code: "RENDER_BUDGET_EXCEEDED",
      message: `${key} peaks at ${peakCost[key]}, above ${DEFAULT_BOARD_RENDER_LIMITS[key]}`,
      path: key,
      adaptation: { quality: "lower" },
    });
  }
  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    peakCost,
  };
}

export function contextualValidation(
  transaction: BoardTransaction,
  context: BoardValidationContext,
): BoardValidationResult {
  const result = structuralValidation(transaction);
  const diagnostics = [...result.diagnostics];
  const nodeIds = new Set(context.nodeIds);
  const nodes = new Map(
    [...(context.nodes ?? [])].map((node) => [node.nodeId, node]),
  );
  const connections = new Map(
    [...context.connections].map((connection) => [connection.id, connection]),
  );
  const effects = new Map([...context.effects].map((effect) => [effect.id, effect.target]));
  const compositions = new Map([...context.compositions].map((composition) => [composition.id, composition]));
  let boardMetadata = context.metadata ?? {};
  const error = (code: string, message: string, path: string) => {
    diagnostics.push({ severity: "error", code, message, path });
  };
  const targetExists = (target: BoardProceduralClip["target"], path: string) => {
    if (target.type === "item" && !nodeIds.has(target.itemId)) error("INVALID_REFERENCE", `target item does not exist: ${target.itemId}`, path);
    if (target.type === "effect" && !effects.has(target.effectId)) error("INVALID_REFERENCE", `target effect does not exist: ${target.effectId}`, path);
  };

  if (transaction.baseVersion !== context.boardVersion) {
    error("VERSION_CONFLICT", `expected Board version ${context.boardVersion}, received ${transaction.baseVersion}`, "baseVersion");
  }

  for (const [index, operation] of transaction.operations.entries()) {
    const path = `operations.${index}`;
    if (operation.type === "board.patch") {
      boardMetadata = operation.payload.patch.metadata ?? boardMetadata;
      if (operation.payload.patch.metadataPatch) {
        boardMetadata = { ...boardMetadata, ...operation.payload.patch.metadataPatch };
      }
      continue;
    }
    if (operation.type === "node.create") {
      if (nodeIds.has(operation.payload.node.nodeId)) error("NODE_EXISTS", `node already exists: ${operation.payload.node.nodeId}`, `${path}.payload.node.nodeId`);
      if (operation.payload.node.parentId && !nodeIds.has(operation.payload.node.parentId)) {
        error("INVALID_REFERENCE", `parent node does not exist: ${operation.payload.node.parentId}`, `${path}.payload.node.parentId`);
      }
      nodeIds.add(operation.payload.node.nodeId);
      nodes.set(operation.payload.node.nodeId, operation.payload.node);
      continue;
    }
    if (operation.type === "node.patch") {
      if (!nodeIds.has(operation.payload.nodeId)) error("NODE_NOT_FOUND", `node does not exist: ${operation.payload.nodeId}`, `${path}.payload.nodeId`);
      if (operation.payload.patch.parentId && !nodeIds.has(operation.payload.patch.parentId)) {
        error("INVALID_REFERENCE", `parent node does not exist: ${operation.payload.patch.parentId}`, `${path}.payload.patch.parentId`);
      }
      const current = nodes.get(operation.payload.nodeId);
      if (current) {
        const next = { ...current, ...operation.payload.patch, nodeId: current.nodeId };
        const nodeDiagnostics = validateBoardNodeInput(next, `${path}.payload.patch`);
        diagnostics.push(...nodeDiagnostics);
        nodes.set(current.nodeId, next);
      }
      continue;
    }
    if (operation.type === "node.delete") {
      if (!nodeIds.has(operation.payload.nodeId)) error("NODE_NOT_FOUND", `node does not exist: ${operation.payload.nodeId}`, `${path}.payload.nodeId`);
      if ([...effects.values()].some((target) => target.type === "item" && target.itemId === operation.payload.nodeId)) {
        error("ITEM_REFERENCED", "delete item effects before deleting the item", `${path}.payload.nodeId`);
      }
      if ([...compositions.values()].some((composition) =>
        composition.timeline.tracks.some((track) => track.target.type === "item" && track.target.itemId === operation.payload.nodeId) ||
        composition.timeline.clips.some((clip) =>
          (clip.target.type === "item" && clip.target.itemId === operation.payload.nodeId) ||
          cameraFocusNodeIds(clip).includes(operation.payload.nodeId)
        )
      )) {
        error("ITEM_REFERENCED", "delete item animation before deleting the item", `${path}.payload.nodeId`);
      }
      // A relation to a deleted node is not a relation, so the edit must say what
      // happens to it. Requiring it in the same transaction is what keeps delete
      // atomic and undo exact: one step removes node and edges, one step restores
      // both. An implicit cascade here would delete rows the inverse never sees.
      const incident = [...connections.values()].filter(
        (connection) =>
          connection.source.itemId === operation.payload.nodeId ||
          connection.target.itemId === operation.payload.nodeId,
      );
      if (incident.length > 0) {
        error(
          "NODE_REFERENCED",
          `delete or repoint the node's connections in the same transaction: ${incident
            .map((connection) => connection.id)
            .join(", ")}`,
          `${path}.payload.nodeId`,
        );
      }
      nodeIds.delete(operation.payload.nodeId);
      nodes.delete(operation.payload.nodeId);
      continue;
    }
    if (operation.type === "connection.create") {
      const { connection } = operation.payload;
      if (connections.has(connection.id)) {
        error("CONNECTION_EXISTS", `connection already exists: ${connection.id}`, `${path}.payload.connection.id`);
      }
      for (const nodeId of connectionItemIds(connection)) {
        if (!nodeIds.has(nodeId)) {
          error("INVALID_REFERENCE", `connection endpoint does not exist: ${nodeId}`, `${path}.payload.connection`);
        }
      }
      connections.set(connection.id, connection);
      continue;
    }
    if (operation.type === "connection.patch") {
      const current = connections.get(operation.payload.connectionId);
      if (!current) {
        error("CONNECTION_NOT_FOUND", `connection does not exist: ${operation.payload.connectionId}`, `${path}.payload.connectionId`);
        continue;
      }
      const next = {
        ...current,
        ...operation.payload.patch,
      } as Pick<BoardConnection, "id" | "source" | "target">;
      for (const nodeId of connectionItemIds(next as BoardConnection)) {
        if (!nodeIds.has(nodeId)) {
          error("INVALID_REFERENCE", `connection endpoint does not exist: ${nodeId}`, `${path}.payload.patch`);
        }
      }
      connections.set(current.id, next);
      continue;
    }
    if (operation.type === "connection.delete") {
      if (!connections.has(operation.payload.connectionId)) {
        error("CONNECTION_NOT_FOUND", `connection does not exist: ${operation.payload.connectionId}`, `${path}.payload.connectionId`);
      }
      connections.delete(operation.payload.connectionId);
      continue;
    }
    if (operation.type === "effect.upsert") {
      const { effect } = operation.payload;
      if (effect.target.type === "item" && !nodeIds.has(effect.target.itemId)) {
        error("INVALID_REFERENCE", `target item does not exist: ${effect.target.itemId}`, `${path}.payload.effect.target`);
      }
      effects.set(effect.id, effect.target);
      continue;
    }
    if (operation.type === "effect.delete") {
      if (!effects.has(operation.payload.effectId)) error("EFFECT_NOT_FOUND", `effect does not exist: ${operation.payload.effectId}`, `${path}.payload.effectId`);
      if ([...compositions.values()].some((composition) =>
        composition.timeline.tracks.some((track) => track.target.type === "effect" && track.target.effectId === operation.payload.effectId) ||
        composition.timeline.clips.some((clip) => clip.target.type === "effect" && clip.target.effectId === operation.payload.effectId)
      )) {
        error("EFFECT_REFERENCED", "effect is referenced by a composition", `${path}.payload.effectId`);
      }
      effects.delete(operation.payload.effectId);
      continue;
    }
    if (operation.type === "composition.apply") {
      const composition = { ...operation.payload.composition, revision: 0 };
      for (const [trackIndex, track] of composition.timeline.tracks.entries()) {
        targetExists(track.target, `${path}.payload.composition.timeline.tracks.${trackIndex}.target`);
      }
      for (const [clipIndex, clip] of composition.timeline.clips.entries()) {
        targetExists(clip.target, `${path}.payload.composition.timeline.clips.${clipIndex}.target`);
        for (const itemId of cameraFocusNodeIds(clip)) {
          if (!nodeIds.has(itemId)) {
            error("INVALID_REFERENCE", `camera focus item does not exist: ${itemId}`, `${path}.payload.composition.timeline.clips.${clipIndex}.params.focus`);
          }
        }
        const focus = BoardCameraFocusParamsSchema.safeParse(clip.params);
        if (
          clip.kind === "camera.focus" &&
          focus.success &&
          focus.data.focus.type === "frame" &&
          nodes.get(focus.data.focus.frameId)?.type !== "frame"
        ) {
          error("INVALID_REFERENCE", `camera focus target is not a frame: ${focus.data.focus.frameId}`, `${path}.payload.composition.timeline.clips.${clipIndex}.params.focus.frameId`);
        }
      }
      compositions.set(composition.id, composition);
      continue;
    }
    if (operation.type === "composition.delete") {
      if (!compositions.has(operation.payload.compositionId)) error("COMPOSITION_NOT_FOUND", `composition does not exist: ${operation.payload.compositionId}`, `${path}.payload.compositionId`);
      compositions.delete(operation.payload.compositionId);
    }
  }

  const playbackPolicy = BoardPlaybackPolicySchema.safeParse(boardMetadata.playback);
  if (playbackPolicy.success && !compositions.has(playbackPolicy.data.compositionId)) {
    error(
      "INVALID_REFERENCE",
      `playback composition does not exist: ${playbackPolicy.data.compositionId}`,
      "board.metadata.playback.compositionId",
    );
  }

  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    peakCost: result.peakCost,
  };
}
