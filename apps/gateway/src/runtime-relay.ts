import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createLogger } from "@cohub/infra/logging";
import { gatewayConfig } from "./config.js";
import { authorizeLocalAcpRuntime, reportLocalAcpRuntimeStatus, touchLocalAcpRuntime } from "./api-client.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

const CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;
const DATA_PAIR_TIMEOUT_MS = 15_000;

const buildRuntimePeerEndpoint = () => {
  const host = gatewayConfig.podIp.includes(":") && !gatewayConfig.podIp.startsWith("[")
    ? `[${gatewayConfig.podIp}]`
    : gatewayConfig.podIp;
  return `ws://${host}:${gatewayConfig.port}/internal/runtime-relay`;
};

export type RuntimeControlFrame = {
  type?: string;
  runtimeId?: string;
  spaceId?: string;
  channel?: string;
  message?: string;
  status?: number;
  kind?: string;
  provider?: string;
};

type RegisteredRuntime = {
  runtimeId: string;
  spaceId: string;
  socket: WebSocket;
  tokenHash: Buffer;
  connectionEpoch: number;
  provider: string;
  connectedAt: number;
};

type PendingRuntimePeer = {
  channelId: string;
  runtimeId: string;
  peerSocket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
};

const runtimesById = new Map<string, RegisteredRuntime>();
const pendingPeers = new Map<string, PendingRuntimePeer>();
type RuntimeDataPair = { peer: WebSocket; runtime: WebSocket };
const dataPairsByRuntime = new Map<string, Set<RuntimeDataPair>>();

const hashToken = (token: string) => createHash("sha256").update(token).digest();
const sameHash = (left: Buffer, right: Buffer) => left.length === right.length && timingSafeEqual(left, right);

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
    pendingPeers.delete(channelId);
    closeSocket(pending.peerSocket, 4409, reason);
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
      if (frame.kind !== "runtime") {
        closeSocket(socket, 4400, "runtime registration kind is required");
        return;
      }
      const runtimeId = typeof frame.runtimeId === "string" ? frame.runtimeId.trim() : "";
      const spaceId = typeof frame.spaceId === "string" ? frame.spaceId.trim() : "";
      const provider = typeof frame.provider === "string" ? frame.provider.trim() : "";
      if (!runtimeId || !spaceId || !provider) {
        sendSocket(socket, { type: "error", status: 400, message: "runtimeId, spaceId, and provider are required" });
        closeSocket(socket, 4400, "runtime identity is incomplete");
        return;
      }
      const auth = await authorizeLocalAcpRuntime({
        authToken: token,
        runtimeId,
        spaceId,
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
      const fenceAuthorizedRuntime = (error: string) => reportLocalAcpRuntimeStatus({
        runtimeId: auth.runtimeId,
        connectionEpoch: auth.connectionEpoch,
        status: "offline",
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
        socket,
        tokenHash: hashToken(token),
        connectionEpoch: auth.connectionEpoch,
        provider: auth.provider,
        connectedAt: Date.now(),
      };
      runtimesById.set(runtimeId, runtime);
      if (!sendSocket(socket, {
        type: "registered",
        runtimeId,
        spaceId: auth.spaceId,
        provider: auth.provider,
        connectionEpoch: auth.connectionEpoch,
        capabilities: auth.capabilities,
      })) {
        await fenceAuthorizedRuntime("runtime registration response could not be sent");
        closeSocket(socket, 4503, "runtime registration failed");
        return;
      }
      logger.info("[RuntimeRelay] local ACP runtime registered", {
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
        void touchLocalAcpRuntime({ runtimeId: runtime.runtimeId, connectionEpoch: runtime.connectionEpoch, authToken: token }).catch((error) => {
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
    await reportLocalAcpRuntimeStatus({
      runtimeId: runtime.runtimeId,
      connectionEpoch: runtime.connectionEpoch,
      status: "offline",
      error: "runtime connection closed",
    }).catch((error) => logger.warn("[RuntimeRelay] failed to report runtime disconnect", {
      runtimeId: runtime?.runtimeId,
      error,
    }));
    logger.info("[RuntimeRelay] local ACP runtime disconnected", {
      runtimeId: runtime.runtimeId,
      spaceId: runtime.spaceId,
    });
  };

  socket.on("close", () => void cleanup());
  socket.on("error", () => void cleanup());
}

export function handleRuntimePeerConnection(socket: WebSocket, request: IncomingMessage, runtimeId: string) {
  const secret = request.headers["x-worker-secret"];
  if (!gatewayConfig.workerSecret || secret !== gatewayConfig.workerSecret) {
    closeSocket(socket, 4401, "unauthorized");
    return;
  }
  const runtime = runtimesById.get(runtimeId);
  if (!runtime) {
    closeSocket(socket, 4404, "local ACP runtime is not connected");
    return;
  }
  // One runtime drives one provider process over one channel. A second peer
  // (a retrying worker, or a second worker racing for the same runtime) must
  // not open a parallel provider against the same local replica; refuse it so
  // the Agent side fails fast instead of the provider running twice.
  const activePairs = dataPairsByRuntime.get(runtimeId);
  const hasPendingPeer = [...pendingPeers.values()].some((pending) => pending.runtimeId === runtimeId);
  if ((activePairs && activePairs.size > 0) || hasPendingPeer) {
    closeSocket(socket, 4409, "local ACP runtime already has an active channel");
    return;
  }

  const channelId = globalThis.crypto.randomUUID();
  const timer = setTimeout(() => {
    const pending = pendingPeers.get(channelId);
    if (!pending) return;
    pendingPeers.delete(channelId);
    closeSocket(socket, 4408, "runtime channel pairing timed out");
  }, DATA_PAIR_TIMEOUT_MS);
  pendingPeers.set(channelId, { channelId, runtimeId, peerSocket: socket, timer });
  socket.on("close", () => {
    const pending = pendingPeers.get(channelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPeers.delete(channelId);
  });

  if (!sendSocket(runtime.socket, { type: "open", channel: channelId, protocol: "acp" })) {
    clearTimeout(timer);
    pendingPeers.delete(channelId);
    logger.warn("[RuntimeRelay] failed to request runtime data channel", { runtimeId, channelId });
    closeSocket(socket, 4503, "runtime unavailable");
  }
}

export async function handleRuntimeDataConnection(runtimeSocket: WebSocket, request: IncomingMessage) {
  const channelId = queryValue(request, "channel");
  if (!channelId) {
    closeSocket(runtimeSocket, 4400, "channel is required");
    return;
  }
  const pending = pendingPeers.get(channelId);
  if (!pending) {
    closeSocket(runtimeSocket, 4404, "unknown or expired channel");
    return;
  }
  const runtime = runtimesById.get(pending.runtimeId);
  const token = parseBearer(request);
  if (!runtime || !token || !sameHash(hashToken(token), runtime.tokenHash)) {
    closeSocket(runtimeSocket, 4401, "unauthorized runtime data channel");
    return;
  }
  const touched = await touchLocalAcpRuntime({
    runtimeId: runtime.runtimeId,
    connectionEpoch: runtime.connectionEpoch,
    authToken: token,
  }).catch(() => false);
  const currentRuntime = runtimesById.get(pending.runtimeId);
  if (!touched || currentRuntime !== runtime || pendingPeers.get(channelId) !== pending) {
    clearTimeout(pending.timer);
    pendingPeers.delete(channelId);
    closeSocket(runtimeSocket, 4401, "runtime authorization is no longer valid");
    closeSocket(pending.peerSocket, 4401, "runtime authorization is no longer valid");
    closeSocket(runtime.socket, 4401, "runtime authorization is no longer valid");
    return;
  }
  clearTimeout(pending.timer);
  pendingPeers.delete(channelId);
  pipeRuntimeSockets(pending.runtimeId, channelId, pending.peerSocket, runtimeSocket);
}

function pipeRuntimeSockets(runtimeId: string, channelId: string, peer: WebSocket, runtime: WebSocket) {
  logger.info("[RuntimeRelay] ACP data channel paired", { runtimeId, channelId });
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
