import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import WebSocket, { type RawData } from "ws";
import { createLogger } from "@cohub/infra/logging";
import {
  isUuid,
  type LOCAL_RUNTIME_PROTOCOL_VERSION,
  LOCAL_RUNTIME_WIRE_PROTOCOL,
  LocalRuntimeOpenFrameSchema,
  LocalRuntimeRegisterFrameSchema,
  type LocalRuntimeRegisterFrame,
  type LocalRuntimeOpenFrame,
} from "@cohub/protocol";
import { gatewayConfig } from "./config.js";
import { authorizeLocalRuntime, reportLocalRuntimeStatus, touchLocalRuntime } from "./api-client.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

const CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Maximum size of the initial JSON open frame on a runtime data socket. */
export const RUNTIME_OPEN_FRAME_MAX_BYTES = 64 * 1024;
/** Bound data that arrives while the authorization touch is in flight. */
export const RUNTIME_OPEN_BUFFER_MAX_BYTES = 1024 * 1024;
export const RUNTIME_OPEN_BUFFER_MAX_FRAMES = 1024;
/** A prompt can contain normalized/base64 image content up to the data limit. */
const RUNTIME_PEER_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_PEER_BUFFER_MAX_FRAMES = 1024;
const DATA_PAIR_TIMEOUT_MS = 15_000;
const RUNTIME_DATA_ROUTE_TTL_SECONDS = Math.ceil(DATA_PAIR_TIMEOUT_MS / 1000) + 5;
const RUNTIME_DATA_ROUTE_PREFIX = "gateway:runtime-relay:data:";

// Keep Redis lazy so pure relay parsing/tests do not open a network connection;
// the Gateway entrypoint already imports the shared client during normal boot.
const runtimeRelayRedis = async () => (await import("./redis.js")).redisCommandClient;

const buildRuntimePeerEndpoint = () => {
  const host = gatewayConfig.podIp.includes(":") && !gatewayConfig.podIp.startsWith("[")
    ? `[${gatewayConfig.podIp}]`
    : gatewayConfig.podIp;
  return `ws://${host}:${gatewayConfig.port}/internal/runtime-relay`;
};

const buildRuntimeDataEndpoint = () => {
  const host = gatewayConfig.podIp.includes(":") && !gatewayConfig.podIp.startsWith("[")
    ? `[${gatewayConfig.podIp}]`
    : gatewayConfig.podIp;
  return `ws://${host}:${gatewayConfig.port}/runtime/relay/data`;
};

export type RuntimeControlFrame = {
  type?: string;
  runtimeId?: string;
  spaceId?: string;
  replicaId?: string;
  deviceId?: string;
  version?: number;
  channel?: string;
  message?: string;
  status?: number;
  kind?: string;
  provider?: string;
  providerVersion?: string;
  adapterVersion?: string;
  protocolVersion?: number;
  capabilities?: Record<string, unknown>;
  protocol?: string;
};

type RuntimeDataRoute = {
  ownerNodeId: string;
  endpoint: string;
  runtimeId: string;
  signature: string;
};

/** Redis key for the short-lived owner hint used by cross-pod data dials. */
export const runtimeDataRouteKey = (channelId: string): string => `${RUNTIME_DATA_ROUTE_PREFIX}${channelId}`;

/** Decode a dynamic relay path segment without letting malformed URLs escape the upgrade handler. */
export const decodeRelayPathSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
};

const effectivePort = (url: URL): string => url.port || (url.protocol === "wss:" ? "443" : "80");

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
};

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb");
};

const isPrivateRuntimeHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const type = isIP(normalized);
  return type === 4 ? isPrivateIpv4(normalized) : type === 6 && isPrivateIpv6(normalized);
};

const isValidRuntimeDataEndpoint = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const expectedPort = Number.isInteger(gatewayConfig.port) && gatewayConfig.port > 0 && gatewayConfig.port <= 65535
      ? String(gatewayConfig.port)
      : null;
    return url.protocol === "ws:"
      && expectedPort !== null
      && effectivePort(url) === expectedPort
      && isPrivateRuntimeHost(hostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === "/runtime/relay/data";
  } catch {
    return false;
  }
};

type RuntimeDataRouteUnsigned = Omit<RuntimeDataRoute, "signature">;

const runtimeDataRouteSigningInput = (channelId: string, route: RuntimeDataRouteUnsigned): string =>
  `cohub-runtime-data-route-v1\0${channelId}\0${route.ownerNodeId}\0${route.runtimeId}\0${route.endpoint}`;

/** Create the Redis owner-hint MAC. The worker secret is shared by gateways. */
export const signRuntimeDataRoute = (channelId: string, route: RuntimeDataRouteUnsigned, secret: string): string =>
  createHmac("sha256", secret).update(runtimeDataRouteSigningInput(channelId, route)).digest("hex");

type RuntimeDataRouteParseOptions = {
  channelId: string;
  signingSecret: string;
};

/**
 * Parse a Redis owner hint without trusting arbitrary endpoint values. Redis is
 * shared infrastructure, so malformed or poisoned records must fail closed.
 */
export const parseRuntimeDataRoute = (value: unknown, options: RuntimeDataRouteParseOptions): RuntimeDataRoute | null => {
  if (typeof value !== "string" || value.length > 4096) return null;
  if (!options.signingSecret || !options.channelId) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.ownerNodeId !== "string" || record.ownerNodeId.length < 1 || record.ownerNodeId.length > 255) return null;
    if (typeof record.runtimeId !== "string" || record.runtimeId.length < 1 || record.runtimeId.length > 255) return null;
    if (!isValidRuntimeDataEndpoint(record.endpoint)) return null;
    if (typeof record.signature !== "string" || !/^[a-f0-9]{64}$/u.test(record.signature)) return null;
    const unsigned: RuntimeDataRouteUnsigned = {
      ownerNodeId: record.ownerNodeId,
      runtimeId: record.runtimeId,
      endpoint: record.endpoint,
    };
    const expected = Buffer.from(signRuntimeDataRoute(options.channelId, unsigned, options.signingSecret), "hex");
    const actual = Buffer.from(record.signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return {
      ...unsigned,
      signature: record.signature,
    };
  } catch {
    return null;
  }
};

/** Keep proxy close frames RFC 6455-sendable; reserved/abnormal codes cannot
 * be sent in a close frame and would otherwise leave the client hanging. */
export const normalizeRuntimeProxyCloseCode = (code: number, opened: boolean): number => {
  const sendable = (value: number): boolean =>
    (value >= 1000 && value <= 1003) || (value >= 1007 && value <= 1014) || (value >= 3000 && value <= 4999);
  return opened && sendable(code) ? code : 4503;
};

const rememberRuntimeDataRoute = async (channelId: string, runtimeId: string): Promise<boolean> => {
  try {
    const signingSecret = gatewayConfig.workerSecret.trim();
    if (!signingSecret) {
      logger.warn("[RuntimeRelay] cannot publish unsigned data-channel owner hint");
      return false;
    }
    const redis = await runtimeRelayRedis();
    const route: RuntimeDataRouteUnsigned = {
      ownerNodeId: gatewayConfig.nodeId,
      endpoint: buildRuntimeDataEndpoint(),
      runtimeId,
    };
    await redis.set(
      runtimeDataRouteKey(channelId),
      JSON.stringify({ ...route, signature: signRuntimeDataRoute(channelId, route, signingSecret) }),
      "EX",
      RUNTIME_DATA_ROUTE_TTL_SECONDS,
    );
    return true;
  } catch (error) {
    logger.warn("[RuntimeRelay] failed to publish data-channel owner hint", { channelId, runtimeId, error });
    return false;
  }
};

const forgetRuntimeDataRoute = async (channelId: string): Promise<void> => {
  try {
    const redis = await runtimeRelayRedis();
    await redis.del(runtimeDataRouteKey(channelId));
  } catch (error) {
    logger.debug("[RuntimeRelay] failed to remove data-channel owner hint", { channelId, error });
  }
};

const lookupRuntimeDataRoute = async (channelId: string): Promise<RuntimeDataRoute | null> => {
  try {
    const redis = await runtimeRelayRedis();
    return parseRuntimeDataRoute(await redis.get(runtimeDataRouteKey(channelId)), {
      channelId,
      signingSecret: gatewayConfig.workerSecret.trim(),
    });
  } catch (error) {
    logger.warn("[RuntimeRelay] failed to look up data-channel owner hint", { channelId, error });
    return null;
  }
};

type RegisteredRuntime = {
  runtimeId: string;
  spaceId: string;
  replicaId: string;
  socket: WebSocket;
  tokenHash: Buffer;
  connectionEpoch: number;
  provider: string;
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  protocol: typeof LOCAL_RUNTIME_WIRE_PROTOCOL;
  connectedAt: number;
};

type PendingRuntimePeer = {
  channelId: string;
  runtimeId: string;
  peerSocket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  binding: RuntimeChannelBinding;
  /** Agent commands can arrive before the locald data handshake completes. */
  peerBufferedMessages: RuntimeBufferedMessage[];
  peerBufferedBytes: number;
  peerBufferOverflowed: boolean;
  peerMessageListener?: (data: RawData, isBinary: boolean) => void;
  /** Set while the runtime data socket is completing its open handshake. */
  runtimeSocket?: WebSocket;
  /** Set synchronously before any async authorization to prevent duplicate dials. */
  claimed: boolean;
};

/**
 * Workspace binding for one local provider channel. The Agent worker sends it as a header
 * when it opens the peer connection; the Gateway forwards it verbatim to the
 * runtime in the `open` frame. locald uses it to claim a one-shot execution
 * permit before starting the provider, so the binding never has to ride inside
 * provider messages and the provider never sees Cohub identifiers.
 */
export type RuntimeChannelBinding = {
  executionAttemptId: string;
  spaceId: string;
  replicaId: string;
  connectionEpoch: number;
  baseSnapshotId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
};

const BINDING_HEADER = "x-cohub-runtime-binding";
const parseRuntimeChannelBindingValue = (value: unknown): RuntimeChannelBinding | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  const ids = [binding.executionAttemptId, binding.spaceId, binding.replicaId, binding.baseSnapshotId];
  if (!ids.every((id) => isUuid(id))) return null;
  if (typeof binding.connectionEpoch !== "number" || !Number.isSafeInteger(binding.connectionEpoch) || binding.connectionEpoch < 1) return null;
  if (typeof binding.leaseEpoch !== "number" || !Number.isSafeInteger(binding.leaseEpoch) || binding.leaseEpoch < 1) return null;
  if (typeof binding.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(binding.leaseExpiresAt))) return null;
  return {
    executionAttemptId: binding.executionAttemptId as string,
    spaceId: binding.spaceId as string,
    replicaId: binding.replicaId as string,
    connectionEpoch: binding.connectionEpoch,
    baseSnapshotId: binding.baseSnapshotId as string,
    leaseEpoch: binding.leaseEpoch,
    leaseExpiresAt: binding.leaseExpiresAt,
  };
};

export const runtimeChannelBindingsEqual = (left: RuntimeChannelBinding, right: RuntimeChannelBinding): boolean =>
  left.executionAttemptId === right.executionAttemptId &&
  left.spaceId === right.spaceId &&
  left.replicaId === right.replicaId &&
  left.connectionEpoch === right.connectionEpoch &&
  left.baseSnapshotId === right.baseSnapshotId &&
  left.leaseEpoch === right.leaseEpoch &&
  left.leaseExpiresAt === right.leaseExpiresAt;

const parseChannelBinding = (request: IncomingMessage): RuntimeChannelBinding | null => {
  const raw = request.headers[BINDING_HEADER];
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseRuntimeChannelBindingValue(value);
};

type RuntimeOpenHandshake = {
  frame: LocalRuntimeOpenFrame;
  binding: RuntimeChannelBinding;
};

const rawSocketData = (data: RawData | unknown): Buffer | null => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return null;
};

export const parseRuntimeOpenFrame = (
  data: unknown,
  isBinary: boolean,
  channelId: string,
  protocol: typeof LOCAL_RUNTIME_WIRE_PROTOCOL,
): RuntimeOpenHandshake | null => {
  if (isBinary) return null;
  const raw = rawSocketData(data);
  if (!raw || raw.byteLength > RUNTIME_OPEN_FRAME_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = LocalRuntimeOpenFrameSchema.safeParse(value);
  if (!parsed.success || parsed.data.channel !== channelId || parsed.data.protocol !== protocol) return null;
  const binding = parseRuntimeChannelBindingValue(parsed.data.binding);
  return binding ? { frame: parsed.data, binding } : null;
};

type RuntimeOpenFrameWaiter = {
  promise: Promise<RuntimeOpenHandshake | null>;
  cancel: () => void;
  release: () => RuntimeBufferedMessage[] | null;
};

type RuntimeBufferedMessage = { data: RawData; isBinary: boolean };

/**
 * Read exactly one runtime data-channel frame before installing transparent
 * forwarding. The frame is an echoed `open` control message and is consumed by
 * the relay; provider-neutral command/event frames start after it.
 */
export const waitForRuntimeOpenFrame = (
  socket: WebSocket,
  channelId: string,
  protocol: typeof LOCAL_RUNTIME_WIRE_PROTOCOL,
): RuntimeOpenFrameWaiter => {
  let settled = false;
  let opened = false;
  let closed = false;
  let bufferOverflowed = false;
  const buffered: RuntimeBufferedMessage[] = [];
  let bufferedBytes = 0;
  let resolvePromise!: (value: RuntimeOpenHandshake | null) => void;
  const promise = new Promise<RuntimeOpenHandshake | null>((resolve) => {
    resolvePromise = resolve;
  });
  const cleanup = () => {
    socket.off("message", onFirstMessage);
    socket.off("message", onBufferedMessage);
    socket.off("close", onClose);
    socket.off("error", onError);
  };
  const finish = (value: RuntimeOpenHandshake | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const onBufferedMessage = (data: RawData, isBinary: boolean) => {
    if (!opened || closed || bufferOverflowed) return;
    const bytes = rawSocketData(data)?.byteLength;
    if (bytes === undefined || buffered.length >= RUNTIME_OPEN_BUFFER_MAX_FRAMES || bufferedBytes + bytes > RUNTIME_OPEN_BUFFER_MAX_BYTES) {
      bufferOverflowed = true;
      cleanup();
      return;
    }
    buffered.push({ data, isBinary });
    bufferedBytes += bytes;
  };
  const onFirstMessage = (data: RawData, isBinary: boolean) => {
    const handshake = parseRuntimeOpenFrame(data, isBinary, channelId, protocol);
    if (!handshake) {
      finish(null);
      return;
    }
    opened = true;
    socket.off("message", onFirstMessage);
    socket.on("message", onBufferedMessage);
    settled = true;
    resolvePromise(handshake);
  };
  const onClose = () => {
    closed = true;
    if (!opened) finish(null);
  };
  const onError = () => {
    closed = true;
    if (!opened) finish(null);
  };
  socket.once("message", onFirstMessage);
  socket.once("close", onClose);
  socket.once("error", onError);
  if (socket.readyState === socket.CLOSED) finish(null);
  return {
    promise,
    cancel: () => {
      closed = true;
      cleanup();
      if (!settled) {
        settled = true;
        resolvePromise(null);
      }
    },
    release: () => {
      if (!opened || closed || bufferOverflowed) {
        cleanup();
        return null;
      }
      socket.off("message", onBufferedMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      return buffered.splice(0);
    },
  };
};

const runtimesById = new Map<string, RegisteredRuntime>();
const pendingPeers = new Map<string, PendingRuntimePeer>();
type RuntimeDataPair = { peer: WebSocket; runtime: WebSocket };
const dataPairsByRuntime = new Map<string, Set<RuntimeDataPair>>();

/**
 * Claim a pending channel synchronously before doing any async authorization.
 * Exported for a focused concurrency test; the pending map itself remains
 * private to this relay module.
 */
export function claimPendingRuntimePeer(pending: Pick<PendingRuntimePeer, "claimed">): boolean {
  if (pending.claimed) return false;
  pending.claimed = true;
  return true;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

const parseBearer = (request: IncomingMessage): string | null => {
  const value = request.headers.authorization;
  if (typeof value !== "string" || value.length > 16 * 1024) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim() || null;
  return token && token.length <= 8 * 1024 ? token : null;
};

const queryValue = (request: IncomingMessage, name: string) => {
  const url = request.url ? new URL(request.url, "http://localhost") : null;
  return url?.searchParams.get(name)?.trim() || null;
};

const closeSocket = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may already have closed.
  }
};

const sendSocket = (socket: WebSocket, payload: unknown) => {
  if (socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

function closePendingPeersForRuntime(runtimeId: string, reason: string) {
  for (const [channelId, pending] of pendingPeers) {
    if (pending.runtimeId !== runtimeId) continue;
    clearTimeout(pending.timer);
    void forgetRuntimeDataRoute(channelId);
    if (pending.peerMessageListener) pending.peerSocket.off("message", pending.peerMessageListener);
    pendingPeers.delete(channelId);
    closeSocket(pending.peerSocket, 4409, reason);
    if (pending.runtimeSocket) closeSocket(pending.runtimeSocket, 4409, reason);
  }
}

function closeDataPairsForRuntime(runtimeId: string, reason: string) {
  const pairs = dataPairsByRuntime.get(runtimeId);
  if (!pairs) return;
  for (const pair of [...pairs]) {
    closeSocket(pair.peer, 4409, reason);
    closeSocket(pair.runtime, 4409, reason);
  }
}

export async function handleRuntimeControlConnection(socket: WebSocket, request: IncomingMessage) {
  const token = parseBearer(request);
  if (!token) {
    closeSocket(socket, 4401, "unauthorized");
    return;
  }

  let runtime: RegisteredRuntime | null = null;
  let cleaned = false;
  let registrationStarted = false;

  socket.on("message", async (data) => {
    const text = data.toString();
    if (Buffer.byteLength(text, "utf8") > CONTROL_MAX_MESSAGE_BYTES) {
      closeSocket(socket, 4400, "message too large");
      return;
    }
    let frame: RuntimeControlFrame;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        closeSocket(socket, 4400, "control message must be an object");
        return;
      }
      frame = parsed as RuntimeControlFrame;
    } catch {
      closeSocket(socket, 4400, "invalid control message");
      return;
    }

    if (frame.type === "register") {
      if (registrationStarted || runtime) {
        closeSocket(socket, 4409, "runtime registration is already complete");
        return;
      }
      registrationStarted = true;
      const registration = LocalRuntimeRegisterFrameSchema.safeParse(frame);
      if (!registration.success) {
        sendSocket(socket, {
          type: "error",
          status: 400,
          message: "invalid local runtime registration frame",
        });
        closeSocket(socket, 4400, "invalid local runtime registration");
        return;
      }
      const registerFrame: LocalRuntimeRegisterFrame = registration.data;
      if (registerFrame.kind !== "runtime") {
        closeSocket(socket, 4400, "runtime registration kind is required");
        return;
      }
      const runtimeId = registerFrame.runtimeId.trim();
      const spaceId = registerFrame.spaceId.trim();
      const provider = registerFrame.provider.trim();
      if (!runtimeId || !spaceId || !provider) {
        sendSocket(socket, { type: "error", status: 400, message: "runtimeId, spaceId, and provider are required" });
        closeSocket(socket, 4400, "runtime identity is incomplete");
        return;
      }
      if (registerFrame.protocol !== LOCAL_RUNTIME_WIRE_PROTOCOL) {
        sendSocket(socket, { type: "error", status: 400, message: "local runtime protocol version is required" });
        closeSocket(socket, 4400, "unsupported local runtime protocol");
        return;
      }
      const auth = await authorizeLocalRuntime({
        authToken: token,
        runtimeId,
        spaceId,
        protocolVersion: registerFrame.protocolVersion,
        gatewayNodeId: gatewayConfig.nodeId,
        gatewayWsEndpoint: buildRuntimePeerEndpoint(),
      }).catch((error) => {
        logger.error("[RuntimeRelay] authorization request failed", { runtimeId, spaceId, error });
        return { ok: false as const, status: 500, message: "runtime authorization failed" };
      });
      if (!auth.ok) {
        sendSocket(socket, { type: "error", status: auth.status, message: auth.message });
        closeSocket(socket, auth.status >= 500 ? 1011 : 4403, auth.status >= 500 ? "authorization unavailable" : "forbidden");
        return;
      }
      const fenceAuthorizedRuntime = (error: string) => reportLocalRuntimeStatus({
        runtimeId: auth.runtimeId,
        connectionEpoch: auth.connectionEpoch,
        protocolVersion: auth.protocolVersion,
        status: "offline",
        authToken: token,
        error,
      }).catch((fenceError) => logger.warn("[RuntimeRelay] failed to fence an authorized runtime", {
        runtimeId,
        error: fenceError,
      }));
      if (socket.readyState !== socket.OPEN) {
        await fenceAuthorizedRuntime("runtime disconnected during authorization");
        return;
      }
      if (provider !== auth.provider) {
        sendSocket(socket, { type: "error", status: 409, message: "runtime provider does not match its registration" });
        await fenceAuthorizedRuntime("runtime provider mismatch");
        closeSocket(socket, 4409, "runtime provider mismatch");
        return;
      }
      if (!auth.replicaId || registerFrame.replicaId !== auth.replicaId) {
        sendSocket(socket, { type: "error", status: 409, message: "runtime replica does not match its registration" });
        await fenceAuthorizedRuntime("runtime replica mismatch");
        closeSocket(socket, 4409, "runtime replica mismatch");
        return;
      }

      const previous = runtimesById.get(runtimeId);
      if (previous && previous.socket !== socket && previous.connectionEpoch > auth.connectionEpoch) {
        await fenceAuthorizedRuntime("runtime authorization was superseded by a newer connection");
        closeSocket(socket, 4409, "replaced by a newer runtime connection");
        return;
      }
      if (previous && previous.socket !== socket) {
        closeSocket(previous.socket, 4409, "replaced by a newer runtime connection");
        closePendingPeersForRuntime(runtimeId, "runtime connection replaced");
        closeDataPairsForRuntime(runtimeId, "runtime connection replaced");
      }
      runtime = {
        runtimeId,
        spaceId: auth.spaceId,
        replicaId: auth.replicaId,
        socket,
        tokenHash: hashToken(token),
        connectionEpoch: auth.connectionEpoch,
        provider: auth.provider,
        protocolVersion: registerFrame.protocolVersion,
        protocol: LOCAL_RUNTIME_WIRE_PROTOCOL,
        connectedAt: Date.now(),
      };
      runtimesById.set(runtimeId, runtime);
      if (!sendSocket(socket, {
        type: "registered",
        runtimeId,
        spaceId: auth.spaceId,
        provider: auth.provider,
        protocol: LOCAL_RUNTIME_WIRE_PROTOCOL,
        connectionEpoch: auth.connectionEpoch,
        capabilities: auth.capabilities,
      })) {
        await fenceAuthorizedRuntime("runtime registration response could not be sent");
        closeSocket(socket, 4503, "runtime registration failed");
        return;
      }
      logger.info("[RuntimeRelay] local runtime registered", {
        runtimeId,
        spaceId: auth.spaceId,
        provider: auth.provider,
        connectionEpoch: auth.connectionEpoch,
      });
      return;
    }

    if (frame.type === "ping") {
      if (!sendSocket(socket, { type: "pong" })) {
        closeSocket(socket, 4503, "runtime heartbeat response could not be sent");
        return;
      }
      if (runtime) {
        void touchLocalRuntime({
          runtimeId: runtime.runtimeId,
          connectionEpoch: runtime.connectionEpoch,
          protocolVersion: runtime.protocolVersion,
          authToken: token,
        }).catch((error) => {
          logger.warn("[RuntimeRelay] runtime heartbeat rejected; closing connection", { runtimeId: runtime?.runtimeId, error });
          closeSocket(socket, 4401, "runtime credential is no longer valid");
        });
      }
    }
  });

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (!runtime || runtimesById.get(runtime.runtimeId)?.socket !== socket) return;
    runtimesById.delete(runtime.runtimeId);
    closePendingPeersForRuntime(runtime.runtimeId, "runtime disconnected");
    closeDataPairsForRuntime(runtime.runtimeId, "runtime disconnected");
    await reportLocalRuntimeStatus({
      runtimeId: runtime.runtimeId,
      connectionEpoch: runtime.connectionEpoch,
      protocolVersion: runtime.protocolVersion,
      status: "offline",
      authToken: token,
      error: "runtime connection closed",
    }).catch((error) => logger.warn("[RuntimeRelay] failed to report runtime disconnect", {
      runtimeId: runtime?.runtimeId,
      error,
    }));
    logger.info("[RuntimeRelay] local runtime disconnected", {
      runtimeId: runtime.runtimeId,
      spaceId: runtime.spaceId,
    });
  };

  socket.on("close", () => void cleanup());
  socket.on("error", () => void cleanup());
}

export async function handleRuntimePeerConnection(socket: WebSocket, request: IncomingMessage, runtimeId: string) {
  const secret = request.headers["x-worker-secret"];
  if (!gatewayConfig.workerSecret || secret !== gatewayConfig.workerSecret) {
    closeSocket(socket, 4401, "unauthorized");
    return;
  }
  const runtime = runtimesById.get(runtimeId);
  if (!runtime) {
    closeSocket(socket, 4404, "local runtime is not connected");
    return;
  }
  const binding = parseChannelBinding(request);
  if (!binding) {
    closeSocket(socket, 4400, "runtime channel binding is required");
    return;
  }
  if (binding.spaceId !== runtime.spaceId) {
    closeSocket(socket, 4403, "runtime channel binding does not match the runtime's Space");
    return;
  }
  if (binding.replicaId !== runtime.replicaId) {
    closeSocket(socket, 4403, "runtime channel binding does not match the runtime's replica");
    return;
  }
  if (binding.connectionEpoch !== runtime.connectionEpoch) {
    closeSocket(socket, 4409, "runtime channel binding is stale");
    return;
  }
  // One runtime drives one provider process over one channel. A second peer
  // (a retrying worker, or a second worker racing for the same runtime) must
  // not open a parallel provider against the same local replica; refuse it so
  // the Agent side fails fast instead of the provider running twice.
  const activePairs = dataPairsByRuntime.get(runtimeId);
  const hasPendingPeer = [...pendingPeers.values()].some((pending) => pending.runtimeId === runtimeId);
  if ((activePairs && activePairs.size > 0) || hasPendingPeer) {
    closeSocket(socket, 4409, "local runtime already has an active channel");
    return;
  }

  const channelId = globalThis.crypto.randomUUID();
  const timer = setTimeout(() => {
    const pending = pendingPeers.get(channelId);
    if (!pending) return;
    void forgetRuntimeDataRoute(channelId);
    if (pending.peerMessageListener) pending.peerSocket.off("message", pending.peerMessageListener);
    pendingPeers.delete(channelId);
    closeSocket(socket, 4408, "runtime channel pairing timed out");
    if (pending.runtimeSocket) closeSocket(pending.runtimeSocket, 4408, "runtime channel pairing timed out");
  }, DATA_PAIR_TIMEOUT_MS);
  const pending: PendingRuntimePeer = {
    channelId,
    runtimeId,
    peerSocket: socket,
    timer,
    binding,
    peerBufferedMessages: [],
    peerBufferedBytes: 0,
    peerBufferOverflowed: false,
    claimed: false,
  };
  pendingPeers.set(channelId, pending);
  // The Agent sends its first command as soon as this socket reaches OPEN.
  // Keep those frames until locald has completed its separate data-channel
  // handshake; EventEmitter would otherwise drop messages with no listener.
  const onPeerMessage = (data: RawData, isBinary: boolean) => {
    if (pendingPeers.get(channelId) !== pending || pending.peerBufferOverflowed) return;
    const bytes = rawSocketData(data)?.byteLength;
    if (bytes === undefined
      || pending.peerBufferedMessages.length >= RUNTIME_PEER_BUFFER_MAX_FRAMES
      || pending.peerBufferedBytes + bytes > RUNTIME_PEER_BUFFER_MAX_BYTES) {
      pending.peerBufferOverflowed = true;
      clearTimeout(pending.timer);
      void forgetRuntimeDataRoute(channelId);
      pending.peerSocket.off("message", onPeerMessage);
      pendingPeers.delete(channelId);
      closeSocket(pending.peerSocket, 4409, "runtime peer buffer exceeded");
      if (pending.runtimeSocket) closeSocket(pending.runtimeSocket, 4409, "runtime peer buffer exceeded");
      return;
    }
    pending.peerBufferedMessages.push({ data, isBinary });
    pending.peerBufferedBytes += bytes;
  };
  pending.peerMessageListener = onPeerMessage;
  socket.on("message", onPeerMessage);
  socket.on("close", () => {
    const pending = pendingPeers.get(channelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    void forgetRuntimeDataRoute(channelId);
    if (pending.peerMessageListener) pending.peerSocket.off("message", pending.peerMessageListener);
    pendingPeers.delete(channelId);
  });

  // Persist a short-lived owner hint before asking locald to dial the data
  // socket. Normally Service ClientIP affinity lands both sockets here; if a
  // load balancer breaks affinity, another Gateway pod can proxy the dial back
  // to this pod over the cluster network.
  const routeRemembered = await rememberRuntimeDataRoute(channelId, runtimeId);
  if (!routeRemembered) {
    logger.warn("[RuntimeRelay] data-channel owner hint unavailable; relying on Service affinity", { runtimeId, channelId });
  }
  if (pendingPeers.get(channelId) !== pending || socket.readyState !== socket.OPEN || runtime.socket.readyState !== runtime.socket.OPEN) {
    removePendingRuntimePeer(channelId, pending);
    closeSocket(socket, 4409, "runtime channel closed during setup");
    return;
  }

  if (!sendSocket(runtime.socket, { type: "open", channel: channelId, protocol: runtime.protocol, binding })) {
    clearTimeout(timer);
    void forgetRuntimeDataRoute(channelId);
    pendingPeers.delete(channelId);
    socket.off("message", onPeerMessage);
    logger.warn("[RuntimeRelay] failed to request runtime data channel", { runtimeId, channelId });
    closeSocket(socket, 4503, "runtime unavailable");
  }
}

const removePendingRuntimePeer = (channelId: string, pending: PendingRuntimePeer): void => {
  clearTimeout(pending.timer);
  void forgetRuntimeDataRoute(channelId);
  if (pending.peerMessageListener) pending.peerSocket.off("message", pending.peerMessageListener);
  if (pendingPeers.get(channelId) === pending) pendingPeers.delete(channelId);
};

const rejectPendingRuntimePair = (
  channelId: string,
  pending: PendingRuntimePeer,
  runtimeSocket: WebSocket,
  code: number,
  reason: string,
): void => {
  removePendingRuntimePeer(channelId, pending);
  closeSocket(runtimeSocket, code, reason);
  closeSocket(pending.peerSocket, code, reason);
};

/**
 * Bridge a data socket that reached a non-owner Gateway pod back to the owner
 * over the cluster network. The client-facing socket stays in this process;
 * only the opaque WebSocket frames cross the internal hop.
 */
async function proxyRuntimeDataConnection(
  runtimeSocket: WebSocket,
  request: IncomingMessage,
  channelId: string,
  route: RuntimeDataRoute,
): Promise<void> {
  const token = parseBearer(request);
  if (!token || !gatewayConfig.workerSecret) {
    closeSocket(runtimeSocket, 4401, "unauthorized runtime data proxy");
    return;
  }

  let target: URL;
  try {
    target = new URL(route.endpoint);
    target.searchParams.set("channel", channelId);
  } catch {
    closeSocket(runtimeSocket, 4404, "invalid runtime data owner");
    return;
  }

  const upstream = new WebSocket(target, {
    handshakeTimeout: DATA_PAIR_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-cohub-runtime-forward": gatewayConfig.workerSecret,
    },
  });
  let opened = false;
  let tornDown = false;
  const buffered: RuntimeBufferedMessage[] = [];
  let bufferedBytes = 0;

  const teardown = (code: number, reason: string) => {
    if (tornDown) return;
    tornDown = true;
    runtimeSocket.off("message", onClientMessage);
    closeSocket(runtimeSocket, code, reason);
    closeSocket(upstream, code, reason);
  };
  const onClientMessage = (data: RawData, isBinary: boolean) => {
    if (tornDown) return;
    if (!opened) {
      const bytes = rawSocketData(data)?.byteLength;
      if (bytes === undefined
        || buffered.length >= RUNTIME_PEER_BUFFER_MAX_FRAMES
        || bufferedBytes + bytes > RUNTIME_PEER_BUFFER_MAX_BYTES) {
        teardown(4409, "runtime data proxy buffer exceeded");
        return;
      }
      buffered.push({ data, isBinary });
      bufferedBytes += bytes;
      return;
    }
    if (upstream.readyState !== upstream.OPEN) return;
    try {
      upstream.send(data, { binary: isBinary });
    } catch {
      teardown(4503, "runtime data proxy send failed");
    }
  };

  runtimeSocket.on("message", onClientMessage);
  runtimeSocket.once("close", () => teardown(1000, "runtime data proxy client closed"));
  runtimeSocket.once("error", () => teardown(4503, "runtime data proxy client error"));
  upstream.once("open", () => {
    if (tornDown) {
      closeSocket(upstream, 1000, "runtime data proxy closed");
      return;
    }
    opened = true;
    for (const message of buffered.splice(0)) {
      if (upstream.readyState !== upstream.OPEN) {
        teardown(4503, "runtime data proxy closed during flush");
        return;
      }
      try {
        upstream.send(message.data, { binary: message.isBinary });
      } catch {
        teardown(4503, "runtime data proxy send failed");
        return;
      }
    }
    upstream.on("message", (data, isBinary) => {
      if (runtimeSocket.readyState !== runtimeSocket.OPEN) return;
      try {
        runtimeSocket.send(data, { binary: isBinary });
      } catch {
        teardown(4503, "runtime data proxy send failed");
      }
    });
  });
  upstream.once("close", (code, reason) => {
    const forwardedCode = normalizeRuntimeProxyCloseCode(code, opened);
    const forwardedReason = reason.toString() || (opened ? "runtime data owner closed" : "runtime data owner unavailable");
    teardown(forwardedCode, forwardedReason);
  });
  upstream.once("unexpected-response", (_request, response) => {
    const statusCode = response.statusCode ?? 0;
    const code = statusCode === 401 || statusCode === 403
      ? 4401
      : statusCode === 404
        ? 4404
        : statusCode === 409
          ? 4409
          : 4503;
    teardown(code, "runtime data owner rejected proxy");
  });
  upstream.once("error", () => {
    teardown(4503, opened ? "runtime data owner error" : "runtime data owner unavailable");
  });
}

export async function handleRuntimeDataConnection(runtimeSocket: WebSocket, request: IncomingMessage) {
  const forwardedSecret = request.headers["x-cohub-runtime-forward"];
  if (forwardedSecret !== undefined && (typeof forwardedSecret !== "string" || !gatewayConfig.workerSecret || forwardedSecret !== gatewayConfig.workerSecret)) {
    closeSocket(runtimeSocket, 4401, "unauthorized runtime data proxy");
    return;
  }
  const token = parseBearer(request);
  if (!token) {
    closeSocket(runtimeSocket, 4401, "unauthorized runtime data channel");
    return;
  }
  const channelId = queryValue(request, "channel");
  if (!channelId) {
    closeSocket(runtimeSocket, 4400, "channel is required");
    return;
  }
  const pending = pendingPeers.get(channelId);
  if (!pending) {
    const route = await lookupRuntimeDataRoute(channelId);
    if (route && route.ownerNodeId !== gatewayConfig.nodeId) {
      await proxyRuntimeDataConnection(runtimeSocket, request, channelId, route);
      return;
    }
    if (route) void forgetRuntimeDataRoute(channelId);
    closeSocket(runtimeSocket, 4404, "unknown or expired channel");
    return;
  }
  const runtime = runtimesById.get(pending.runtimeId);
  if (!runtime) {
    clearTimeout(pending.timer);
    void forgetRuntimeDataRoute(channelId);
    if (pending.peerMessageListener) pending.peerSocket.off("message", pending.peerMessageListener);
    pendingPeers.delete(channelId);
    closeSocket(pending.peerSocket, 4404, "local runtime is no longer connected");
    closeSocket(runtimeSocket, 4404, "local runtime is no longer connected");
    return;
  }
  // The token touch below is asynchronous. Claim the pending entry before
  // awaiting it so two runtime dials for one channel cannot both pass the
  // identity checks and create parallel provider pipes.
  if (!claimPendingRuntimePeer(pending)) {
    closeSocket(runtimeSocket, 4409, "runtime channel is already being paired");
    return;
  }
  pending.runtimeSocket = runtimeSocket;
  const openWaiter = waitForRuntimeOpenFrame(runtimeSocket, channelId, runtime.protocol);
  const touched = await touchLocalRuntime({
      runtimeId: runtime.runtimeId,
      connectionEpoch: runtime.connectionEpoch,
      protocolVersion: runtime.protocolVersion,
      authToken: token,
  }).catch(() => false);
  const currentRuntime = runtimesById.get(pending.runtimeId);
  if (!touched || currentRuntime !== runtime || pendingPeers.get(channelId) !== pending || runtime.socket.readyState !== runtime.socket.OPEN || runtimeSocket.readyState !== runtimeSocket.OPEN) {
    openWaiter.cancel();
    removePendingRuntimePeer(channelId, pending);
    closeSocket(runtimeSocket, 4401, "runtime authorization is no longer valid");
    closeSocket(pending.peerSocket, 4401, "runtime authorization is no longer valid");
    closeSocket(runtime.socket, 4401, "runtime authorization is no longer valid");
    return;
  }
  const handshake = await openWaiter.promise;
  if (!handshake || !runtimeChannelBindingsEqual(handshake.binding, pending.binding)) {
    logger.warn("[RuntimeRelay] runtime data channel binding mismatch", { runtimeId: runtime.runtimeId, channelId });
    rejectPendingRuntimePair(channelId, pending, runtimeSocket, 4403, "runtime channel binding mismatch");
    return;
  }
  const buffered = openWaiter.release();
  if (!buffered || runtimeSocket.readyState !== runtimeSocket.OPEN || pendingPeers.get(channelId) !== pending) {
    rejectPendingRuntimePair(channelId, pending, runtimeSocket, 4403, "runtime channel closed during binding handshake");
    return;
  }
  if (pending.peerBufferOverflowed || pending.peerSocket.readyState !== pending.peerSocket.OPEN) {
    rejectPendingRuntimePair(channelId, pending, runtimeSocket, 4409, "runtime peer closed during binding handshake");
    return;
  }
  const bufferedPeerMessages = pending.peerBufferedMessages.splice(0);
  // Access tokens can rotate while the long-lived control socket remains up.
  // The API touch above authenticates the token against the runtime/device and
  // current connection epoch; once that succeeds, remember this token for the
  // next data dial without trusting an unvalidated bearer value.
  runtime.tokenHash = hashToken(token);
  removePendingRuntimePeer(channelId, pending);
  pipeRuntimeSockets(pending.runtimeId, channelId, pending.peerSocket, runtimeSocket, buffered, bufferedPeerMessages);
}

function pipeRuntimeSockets(
  runtimeId: string,
  channelId: string,
  peer: WebSocket,
  runtime: WebSocket,
  bufferedRuntimeMessages: RuntimeBufferedMessage[] = [],
  bufferedPeerMessages: RuntimeBufferedMessage[] = [],
) {
  logger.info("[RuntimeRelay] local runtime data channel paired", { runtimeId, channelId });
  const pair: RuntimeDataPair = { peer, runtime };
  const pairs = dataPairsByRuntime.get(runtimeId) ?? new Set<RuntimeDataPair>();
  pairs.add(pair);
  dataPairsByRuntime.set(runtimeId, pairs);
  let tornDown = false;
  const teardown = (reason: string) => {
    if (tornDown) return;
    tornDown = true;
    pairs.delete(pair);
    if (pairs.size === 0) dataPairsByRuntime.delete(runtimeId);
    closeSocket(peer, 1000, reason);
    closeSocket(runtime, 1000, reason);
  };
  // Replay Agent commands first. Runtime output can only be causally related
  // to those commands, so this preserves the direction of the handshake when
  // both sockets had data waiting at the pairing boundary.
  for (const message of bufferedPeerMessages) {
    if (runtime.readyState !== runtime.OPEN) {
      teardown("runtime closed before channel pairing completed");
      break;
    }
    try {
      runtime.send(message.data, { binary: message.isBinary });
    } catch {
      teardown("data channel send failed");
      break;
    }
  }
  for (const message of bufferedRuntimeMessages) {
    if (peer.readyState !== peer.OPEN) {
      teardown("peer closed before runtime channel pairing completed");
      break;
    }
    try {
      peer.send(message.data, { binary: message.isBinary });
    } catch {
      teardown("data channel send failed");
      break;
    }
  }
  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState !== to.OPEN) return;
      try {
        to.send(data, { binary: isBinary });
      } catch {
        teardown("data channel send failed");
      }
    });
  };
  forward(peer, runtime);
  forward(runtime, peer);
  peer.on("close", () => teardown("peer closed"));
  runtime.on("close", () => teardown("runtime closed"));
  peer.on("error", () => teardown("peer error"));
  runtime.on("error", () => teardown("runtime error"));
}
