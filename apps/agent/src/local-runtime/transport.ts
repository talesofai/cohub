import WebSocket, { type RawData } from "ws";
import { TextDecoder } from "node:util";
import type { localAgentRuntimes } from "@cohub/db";
import {
  LOCAL_RUNTIME_WIRE_PROTOCOL,
  LocalRuntimeCommandSchema,
  LocalRuntimeDataFrameSchema,
  type LocalRuntimeEvent,
  type LocalRuntimeCommand,
} from "@cohub/protocol";
import { env } from "../env.js";
import { selectRuntimeRelayEndpoint } from "./relay-endpoint.js";

/**
 * Transport for the provider-neutral local-runtime protocol.
 *
 * The relay is deliberately byte-transparent: this side sends canonical
 * command envelopes and receives canonical event envelopes. Provider SDK
 * objects never cross this boundary. WebSocket messages are treated as a
 * stream of LF-delimited JSON records because locald forwards provider-host
 * stdio using the same framing.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RUNTIME_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 16_384;

export const RUNTIME_CWD = "/workspace";
export const RUNTIME_BUSY_CLOSE_CODE = 4409;

export type RuntimeChannelBinding = {
  executionAttemptId: string;
  spaceId: string;
  replicaId: string;
  /** Runtime connection epoch fences stale workers from a replacement host. */
  connectionEpoch: number;
  baseSnapshotId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
};

export type RuntimeChannelClosed = { code: number; reason: string };

export type RuntimeChannel = {
  /** Send one validated canonical command to the local host. */
  send(command: LocalRuntimeCommand): Promise<void>;
  /** Wait for the next canonical provider event. */
  nextEvent(signal?: AbortSignal): Promise<LocalRuntimeEvent>;
  /** Iterate events until the channel closes. */
  events(signal?: AbortSignal): AsyncIterable<LocalRuntimeEvent>;
  /** Resolves exactly once when the underlying socket closes. */
  closed: Promise<RuntimeChannelClosed>;
  close(): void;
  readonly closeCode: number | null;
};

function peerUrl(runtime: typeof localAgentRuntimes.$inferSelect): string {
  const base = selectRuntimeRelayEndpoint(runtime.gatewayWsEndpoint, env.LOCAL_RUNTIME_RELAY_URL);
  return `${base}/${encodeURIComponent(runtime.id)}`;
}

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "local runtime event wait aborted");
  error.name = "AbortError";
  return error;
}

type EventWaiter = {
  resolve: (event: LocalRuntimeEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function removeWaiterAbortListener(waiter: EventWaiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
}

class RuntimeEventQueue {
  private readonly values: LocalRuntimeEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private failure: Error | null = null;
  private ended = false;

  push(event: LocalRuntimeEvent): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      removeWaiterAbortListener(waiter);
      waiter.resolve(event);
      return;
    }
    if (this.values.length >= MAX_QUEUED_EVENTS) {
      this.fail(new Error("local runtime event queue is full"));
      return;
    }
    this.values.push(event);
  }

  next(signal?: AbortSignal): Promise<LocalRuntimeEvent> {
    if (this.values.length > 0) {
      const event = this.values.shift();
      if (event) return Promise.resolve(event);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error("local runtime channel is closed"));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise<LocalRuntimeEvent>((resolve, reject) => {
      const waiter: EventWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  end(error?: Error): void {
    if (this.ended || this.failure) return;
    if (error) {
      this.fail(error);
      return;
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      removeWaiterAbortListener(waiter);
      waiter.reject(new Error("local runtime channel is closed"));
    }
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      removeWaiterAbortListener(waiter);
      waiter.reject(error);
    }
    this.values.length = 0;
  }
}

class RuntimeChannelImpl implements RuntimeChannel {
  readonly closed: Promise<RuntimeChannelClosed>;
  private readonly queue = new RuntimeEventQueue();
  private readonly socket: WebSocket;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private resolveClosed!: (value: RuntimeChannelClosed) => void;
  private closeCodeValue: number | null = null;
  private frameBuffer = "";
  private closedValue = false;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise<RuntimeChannelClosed>((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    socket.on("error", (error) => this.handleError(error instanceof Error ? error : new Error(String(error))));
  }

  get closeCode(): number | null {
    return this.closeCodeValue;
  }

  async send(command: LocalRuntimeCommand): Promise<void> {
    const parsed = LocalRuntimeCommandSchema.safeParse(command);
    if (!parsed.success) throw new Error(`invalid local runtime command: ${parsed.error.message}`);
    if (this.closedValue || this.socket.readyState !== WebSocket.OPEN) throw new Error("local runtime channel is closed");
    const encoded = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) throw new Error("local runtime command exceeds the message size limit");
    await new Promise<void>((resolve, reject) => {
      try {
        this.socket.send(encoded, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  nextEvent(signal?: AbortSignal): Promise<LocalRuntimeEvent> {
    return this.queue.next(signal);
  }

  async *events(signal?: AbortSignal): AsyncIterable<LocalRuntimeEvent> {
    while (true) yield await this.nextEvent(signal);
  }

  close(): void {
    if (this.closedValue) return;
    try {
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else this.socket.close(1000, "local runtime client closed");
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleMessage(data: RawData): void {
    const bytes = rawBytes(data);
    if (bytes.byteLength > MAX_RUNTIME_MESSAGE_BYTES) {
      this.handleError(new Error("local runtime message exceeds the size limit"));
      this.close();
      return;
    }
    let text: string;
    try {
      // Keep decoding state across WebSocket messages: a relay may split a
      // UTF-8 sequence at a message boundary. Fatal mode rejects replacement
      // characters instead of handing altered JSON to the runtime ledger.
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.handleError(new Error("local runtime sent invalid UTF-8"));
      return;
    }
    this.frameBuffer += text;
    if (Buffer.byteLength(this.frameBuffer, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) {
      this.handleError(new Error("local runtime frame exceeds the size limit"));
      this.close();
      return;
    }
    while (true) {
      const newline = this.frameBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.frameBuffer.slice(0, newline);
      this.frameBuffer = this.frameBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.parseLine(line);
      if (this.closedValue) return;
    }
  }

  private parseLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.handleError(new Error("local runtime sent invalid JSON"));
      this.close();
      return;
    }
    const parsed = LocalRuntimeDataFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.type !== "event") {
      this.handleError(new Error("local runtime sent an invalid event frame"));
      this.close();
      return;
    }
    this.queue.push(parsed.data);
  }

  private handleError(error: Error): void {
    if (this.closedValue) return;
    this.queue.fail(error);
    // `ws` normally emits `close` after `error`, but that is not guaranteed
    // for a transport that is already half-closed (and custom WebSocket
    // implementations may omit it entirely). Finalize the channel here so
    // callers waiting on `closed` cannot retain an execution forever.
    this.finishClosed(1006, error.message || "local runtime socket error");
    try {
      if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    } catch {
      // The socket may have transitioned to CLOSED while handling the error.
    }
  }

  private handleClose(code: number, reason: string): void {
    if (!this.closedValue) {
      try {
        // Flush the streaming decoder so a truncated trailing code point is
        // reported as a transport error rather than silently discarded.
        this.decoder.decode();
      } catch {
        this.handleError(new Error("local runtime sent invalid UTF-8"));
        return;
      }
    }
    this.finishClosed(code, reason);
  }

  private finishClosed(code: number, reason: string): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.closeCodeValue = code;
    this.queue.end();
    this.resolveClosed({ code, reason });
  }
}

/** Open a peer channel and attach the workspace lease binding. */
export async function openRuntimeChannel(
  runtime: typeof localAgentRuntimes.$inferSelect,
  binding: RuntimeChannelBinding,
): Promise<RuntimeChannel> {
  const headers: Record<string, string> = {
    "x-cohub-runtime-binding": JSON.stringify(binding),
    ...(env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : {}),
  };
  const socket = new WebSocket(peerUrl(runtime), { headers, maxPayload: MAX_RUNTIME_MESSAGE_BYTES });
  const channel = new RuntimeChannelImpl(socket);
  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("local runtime connection timed out"));
    }, CONNECT_TIMEOUT_MS);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(code === RUNTIME_BUSY_CLOSE_CODE
        ? new Error("local runtime already has an active channel")
        : new Error(`local runtime connection closed (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  return channel;
}

export { LOCAL_RUNTIME_WIRE_PROTOCOL };
