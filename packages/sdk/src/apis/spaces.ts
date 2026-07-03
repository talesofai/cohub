import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import { getRealtimeSpaceRoom } from "@cohub/protocol/realtime/types";
import { ensureRealtimeConnected } from "../realtime.js";
import type { WebsocketClient, WebsocketEventPayload } from "../websocket.js";
import { HttpError, type HttpTransport, type Fetch } from "../transport.js";
import {
  SessionPatchReducer,
  type SessionPatchApplyInput,
  type SessionPatchApplyResult,
} from "../session-patch-reducer.js";
import {
  SessionGenerationStreamClient,
  type GenerationStreamSubscribeOptions,
  type GenerationStreamSubscriptionHandlers,
} from "../session-generation-stream.js";
import type {
  CheckpointRecord,
  SessionForkRecord,
  SessionMessageResponse,
  SessionMessagesPaginatedResponse,
  SessionMessagesResponse,
  SessionTurnResponse,
  SessionTurnRecord,
  SessionTurnStreamSnapshotResponse,
  SessionTurnIndexResponse,
  SessionTurnWindowResponse,
  SessionTurnsPaginatedResponse,
  SessionTurnSignedUrlsResponse,
  SessionRecord,
  SpaceAccessPolicy,
  SpaceCheckpointDetailResponse,
  SpaceCreateResponse,
  SpacePresenceSnapshot,
  SpaceDefaultResponse,
  CreateSpacePromptInput,
  CreateSpacePromptResponse,
  SpaceEnvInput,
  SpaceFsCompleteUploadInput,
  SpaceFsCompleteUploadResponse,
  SpaceFsCreateUploadInput,
  SpaceFsCreateUploadResponse,
  SpaceFsFileResponse,
  SpaceFsPreparingFile,
  SpaceFsReadFilesResponse,
  SpaceFsMoveInput,
  SpaceFsTreeResponse,
  SpaceFsUploadResponse,
  SpaceUsageResponse,
  SpaceFsWriteFileInput,
  LabelAssignmentListItem,
  LabelAssignmentPageInfo,
  LabelAssignmentRecord,
  LabelListItem,
  LabelResourceType,
  PatchResourceLabelsInput,
  PatchResourceLabelsResponse,
  SpaceModListItem,
  SpaceMember,
  SpaceRecord,
  SpaceRole,
  SpaceSessionsResponse,
  CreateSpaceSessionInput,
  CreateSpaceInput,
  SpaceConfigInput,
  SpaceConfigResponse,
  CanvasBootstrapResponse,
  CanvasCreateInput,
  CanvasDocumentRecord,
  CanvasTransactionInput,
} from "../types.js";
import { SpaceInvitationsApi } from "./invitations.js";


const getFilenameFromContentDisposition = (value: string | null) => {
  if (!value) return null;

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? null;
};

export type SessionSubscriptionHandlers = {
  patch?: (event: WebsocketEventPayload) => void;
  /** @deprecated Use `session.subscribeGeneration({ state })`. */
  patchState?: (result: SessionPatchApplyResult) => void;
  turnUpdated?: (event: WebsocketEventPayload) => void;
  turnFinalized?: (event: WebsocketEventPayload) => void;
  error?: (event: WebsocketEventPayload) => void;
  persisted?: (event: WebsocketEventPayload) => void;
  event?: (event: WebsocketEventPayload) => void;
};

export type SessionEventName = "created" | "updated" | "turn.created" | "turn.patch" | "turn.lifecycle" | "turn.updated" | "turn.finalized" | "turn.error" | "message.persisted";
export type SpaceEventName = SessionEventName | "fs.changed" | "ports.changed" | "presence.updated" | "canvas.tx.applied" | "canvas.tx.ack" | "canvas.tx.error" | "task.created" | "task.updated" | "event";

const toSessionEventName = (type: WebsocketEventPayload["type"]): SessionEventName | null => {
  switch (type) {
    case "session.created":
      return "created";
    case "session.updated":
      return "updated";
    case "session.turn.created":
      return "turn.created";
    case "session.turn.patch":
      return "turn.patch";
    case "session.turn.error":
      return "turn.error";
    case "session.turn.lifecycle":
      return "turn.lifecycle";
    case "session.turn.updated":
      return "turn.updated";
    case "session.turn.finalized":
      return "turn.finalized";
    case "session.message.persisted":
      return "message.persisted";
    default:
      return null;
  }
};

const isAssistantFinalPersistedEvent = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return false;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return false;
  const record = message as {
    role?: unknown;
    meta?: Record<string, unknown> | null;
  };
  return record.role === "assistant" && (record.meta?.messageKind === "assistant_final" || record.meta?.messageKind === "assistant_error");
};

const isAssistantIntermediatePersistedEvent = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return false;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return false;
  const record = message as {
    role?: unknown;
    meta?: Record<string, unknown> | null;
  };
  return record.role === "assistant" && record.meta?.messageKind === "assistant_intermediate";
};

const getPersistedMessageTurnId = (event: WebsocketEventPayload) => {
  if (event.type !== "session.message.persisted") return null;
  const message = event.payload.message;
  if (!message || typeof message !== "object") return null;
  const meta = (message as { meta?: Record<string, unknown> | null }).meta;
  return typeof meta?.turnId === "string" ? meta.turnId : null;
};

export class SpacesApi {
  constructor(private readonly transport: HttpTransport) {}

  list(customFetch?: Fetch) {
    return this.transport.request<SpaceRecord[]>("/api/spaces", {
      method: "GET",
      fetch: customFetch,
    });
  }

  getDefault(customFetch?: Fetch) {
    return this.transport.request<SpaceDefaultResponse>("/api/spaces/default", {
      method: "GET",
      fetch: customFetch,
    });
  }

  get(spaceId: string, customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(`/api/spaces/${spaceId}`, {
      fetch: customFetch,
    });
  }

  getBySlug(username: string, slug: string, customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(
      `/api/spaces/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`,
      { fetch: customFetch },
    );
  }

  create(
    input?: CreateSpaceInput,
    headers?: Record<string, string>,
  ) {
    return this.transport.request<SpaceCreateResponse>("/api/spaces", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input ?? {}),
    });
  }
}

export class SpaceFilesApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list(path = "", customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const query = params.toString();
    return this.transport.request<SpaceFsTreeResponse>(
      `/api/spaces/${this.spaceId}/fs/tree${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  read(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<SpaceFsFileResponse | SpaceFsPreparingFile>(
      `/api/spaces/${this.spaceId}/fs/file?${params.toString()}`,
      { fetch: customFetch },
    );
  }

  readMany(paths: string[], customFetch?: Fetch) {
    return this.transport.request<SpaceFsReadFilesResponse>(
      `/api/spaces/${this.spaceId}/fs/files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
        fetch: customFetch,
      },
    );
  }

  /**
   * Build a direct download URL. For private files, prefer `download()` so the
   * SDK can attach authorization headers.
   */
  getDownloadUrl(path: string) {
    const params = new URLSearchParams({ path });
    return `/api/spaces/${this.spaceId}/fs/download?${params.toString()}`;
  }

	async download(path: string, customFetch?: Fetch) {
		const params = new URLSearchParams({ path });
		const raw = await this.transport.raw(
			`/api/spaces/${this.spaceId}/fs/download?${params.toString()}`,
			{ fetch: customFetch },
		);
		if (raw.response.status === 202) {
			throw new HttpError(
				"File is being prepared. Please retry shortly.",
				202,
				await raw.json().catch(() => null),
			);
		}
		const blob = await raw.blob();
		const filename =
			getFilenameFromContentDisposition(
				raw.response.headers.get("content-disposition"),
			) ??
			path.split("/").pop() ??
			"download";
		const mimeType =
			raw.response.headers.get("content-type") ??
			blob.type ??
			"application/octet-stream";

		return { blob, filename, mimeType };
	}

  write(input: SpaceFsWriteFileInput) {
    return this.transport.request<{ ok: true; path: string; size: number; mtimeMs: number }>(
      `/api/spaces/${this.spaceId}/fs/file`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  createDir(path: string) {
    return this.transport.request<{ ok: true; path: string; size: number; mtimeMs: number }>(
      `/api/spaces/${this.spaceId}/fs/dir`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      },
    );
  }

  delete(path: string, recursive = false) {
    const params = new URLSearchParams({ path });
    if (recursive) params.set("recursive", "true");
    return this.transport.request<{ ok: true; path: string }>(
      `/api/spaces/${this.spaceId}/fs/node?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  move(input: SpaceFsMoveInput) {
    return this.transport.request<{ ok: true; fromPath: string; toPath: string }>(
      `/api/spaces/${this.spaceId}/fs/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  upload(files: File[], dir = "") {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    const query = params.toString();
    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    return this.transport.request<SpaceFsUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/upload${query ? `?${query}` : ""}`,
      {
        method: "POST",
        body: formData,
      },
    );
  }

  createUpload(input: SpaceFsCreateUploadInput) {
    return this.transport.request<SpaceFsCreateUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  completeUpload(uploadId: string, input: SpaceFsCompleteUploadInput) {
    return this.transport.request<SpaceFsCompleteUploadResponse>(
      `/api/spaces/${this.spaceId}/fs/uploads/${uploadId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }
}

class SessionMessagesClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly sessionId: string,
  ) {}

  list(customFetch?: Fetch) {
    return this.transport.request<SessionMessagesResponse>(
      `/api/sessions/${this.sessionId}/messages`,
      {
        fetch: customFetch,
      },
    );
  }

  get(
    messageId: string,
    optionsOrFetch?: { detail?: "summary" | "full" } | Fetch,
    customFetch?: Fetch,
  ) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.detail) params.set("detail", options.detail);
    const query = params.toString();
    return this.transport.request<SessionMessageResponse>(
      `/api/sessions/${this.sessionId}/messages/${messageId}${query ? `?${query}` : ""}`,
      {
        fetch,
      },
    );
  }

  listPaginated(
    options?: {
      cursor?: number;
      limit?: number;
      direction?: "older" | "newer";
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.direction) params.set("direction", options.direction);
    const query = params.toString();
    return this.transport.request<SessionMessagesPaginatedResponse>(
      `/api/sessions/${this.sessionId}/messages${query ? `?${query}` : ""}`,
      {
        fetch: customFetch,
      },
    );
  }

}

class SessionTurnsClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly sessionId: string,
  ) {}

  listPaginated(
    options?: {
      cursor?: number;
      limit?: number;
      direction?: "older" | "newer";
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.direction) params.set("direction", options.direction);
    const query = params.toString();
    return this.transport.request<SessionTurnsPaginatedResponse>(
      `/api/sessions/${this.sessionId}/turns${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  index(
    options?: {
      cursor?: number;
      limit?: number;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.transport.request<SessionTurnIndexResponse>(
      `/api/sessions/${this.sessionId}/turns/index${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  window(
    options: {
      sequence?: number;
      turnId?: string;
      before?: number;
      after?: number;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (options.sequence !== undefined) params.set("sequence", String(options.sequence));
    if (options.turnId) params.set("turnId", options.turnId);
    if (options.before !== undefined) params.set("before", String(options.before));
    if (options.after !== undefined) params.set("after", String(options.after));
    const query = params.toString();
    return this.transport.request<SessionTurnWindowResponse>(
      `/api/sessions/${this.sessionId}/turns/window${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  streamSnapshot(customFetch?: Fetch) {
    return this.transport.request<SessionTurnStreamSnapshotResponse>(
      `/api/sessions/${this.sessionId}/turns/stream-snapshot`,
      { fetch: customFetch },
    );
  }

  get(turnId: string, customFetch?: Fetch) {
    return this.transport.request<SessionTurnResponse>(
      `/api/sessions/${this.sessionId}/turns/${turnId}`,
      { fetch: customFetch },
    );
  }

  signedUrls(turnId: string, objectKeys: string[]) {
    return this.transport.request<SessionTurnSignedUrlsResponse>(
      `/api/sessions/${this.sessionId}/turns/${turnId}/signed-urls`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectKeys }),
      },
    );
  }
}

class SessionRealtimeClient {
  private readonly patchReducer = new SessionPatchReducer();

  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
    private readonly sessionId: string,
  ) {}

  subscribe(handlers: SessionSubscriptionHandlers) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const releaseRoom = this.websocketClient.retainRooms([getRealtimeSpaceRoom(this.spaceId)]);
    const unsubscribe = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId || event.sessionId !== this.sessionId) return;
      handlers.event?.(event);
      const eventName = toSessionEventName(event.type);
      if (eventName === "turn.patch") {
        handlers.patch?.(event);
        if (event.type === "session.turn.patch") {
          const payload = event.payload;
          if (
            typeof payload.seq === "number" &&
            typeof payload.baseSeq === "number" &&
            Array.isArray(payload.ops)
          ) {
            handlers.patchState?.(
              this.patchReducer.applyPatch({
                spaceId: this.spaceId,
                sessionId: this.sessionId,
                turnId: typeof payload.turnId === "string" ? payload.turnId : null,
                seq: payload.seq,
                baseSeq: payload.baseSeq,
                ops: payload.ops as SessionPatchApplyInput["ops"],
                anchorUserMessageId:
                  typeof payload.anchorUserMessageId === "string"
                    ? payload.anchorUserMessageId
                    : null,
              }),
            );
          }
        }
      }
      if (eventName === "turn.error") {
        this.patchReducer.fail({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
        });
        handlers.error?.(event);
      }
      if (eventName === "message.persisted") {
        handlers.persisted?.(event);
        if (isAssistantIntermediatePersistedEvent(event)) {
          this.patchReducer.reset({
            spaceId: this.spaceId,
            sessionId: this.sessionId,
          });
        }
      }
      if (eventName === "turn.updated") handlers.turnUpdated?.(event);
      if (eventName === "turn.finalized") {
        this.patchReducer.complete({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
          turnId: typeof event.payload.turn === "object" && event.payload.turn && "id" in event.payload.turn ? String(event.payload.turn.id) : null,
        });
        handlers.turnFinalized?.(event);
      }
      if (isAssistantFinalPersistedEvent(event)) {
        this.patchReducer.complete({
          spaceId: this.spaceId,
          sessionId: this.sessionId,
          turnId: getPersistedMessageTurnId(event),
        });
      }
    });
    return () => {
      unsubscribe();
      releaseRoom();
    };
  }

  on(type: SessionEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.subscribe({
      event: (event) => {
        if (toSessionEventName(event.type) === type) handler(event);
      },
    });
  }
}

export class SessionClient {
  readonly messages: SessionMessagesClient;
  readonly turns: SessionTurnsClient;
  readonly realtime: SessionRealtimeClient;
  readonly generation: SessionGenerationStreamClient;

  constructor(
    readonly spaceId: string,
    readonly id: string,
    private readonly transport: HttpTransport,
    websocketClient: WebsocketClient | null,
  ) {
    this.messages = new SessionMessagesClient(transport, id);
    this.turns = new SessionTurnsClient(transport, id);
    this.realtime = new SessionRealtimeClient(websocketClient, spaceId, id);
    this.generation = new SessionGenerationStreamClient(
      websocketClient,
      spaceId,
      id,
      () => this.turns.streamSnapshot(),
    );
  }

  get(customFetch?: Fetch) {
    return this.transport.request<{ space: SpaceRecord; session: SessionRecord }>(
      `/api/sessions/${this.id}`,
      {
        fetch: customFetch,
      },
    );
  }

  rename(title: string | null, customFetch?: Fetch) {
    return this.transport.request<{ session: SessionRecord }>(
      `/api/sessions/${this.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
        fetch: customFetch,
      },
    );
  }

  steerTurn(turnId: string, customFetch?: Fetch) {
    return this.transport.request<{ ok: true; turn: SessionTurnRecord; affectedTurns: SessionTurnRecord[] }>(
      `/api/spaces/${this.spaceId}/sessions/${this.id}/turns/${turnId}/steer`,
      { method: "POST", fetch: customFetch },
    );
  }

  cancelTurn(turnId: string, customFetch?: Fetch) {
    return this.transport.request<{ ok: true; turn: SessionTurnRecord }>(
      `/api/spaces/${this.spaceId}/sessions/${this.id}/turns/${turnId}/cancel`,
      { method: "POST", fetch: customFetch },
    );
  }

  abort(optionsOrFetch?: { turnId?: string | null } | Fetch, customFetch?: Fetch) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    return this.transport.request<{ ok: true }>(
      `/api/sessions/${this.id}/abort`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: options?.turnId ?? null }),
        fetch,
      },
    );
  }

  turn(turnId: string) {
    return {
      fork: (input: { title?: string | null } = {}) => this.transport.request<{ session: SessionRecord; fork: SessionForkRecord }>(
        `/api/sessions/${this.id}/turns/${turnId}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    };
  }

  subscribe(handlers: SessionSubscriptionHandlers) {
    return this.realtime.subscribe(handlers);
  }

  subscribeGeneration(
    handlers: GenerationStreamSubscriptionHandlers,
    options?: GenerationStreamSubscribeOptions,
  ) {
    return this.generation.subscribe(handlers, options);
  }

  on(type: SessionEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.realtime.on(type, handler);
  }
}

export class SpaceSessionsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly websocketClient: WebsocketClient | null,
  ) {}

  create(input?: CreateSpaceSessionInput) {
    return this.transport.request<{ ok: true; session: SessionRecord }>(
      `/api/spaces/${this.spaceId}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input ?? {}),
      },
    );
  }

  list(
    optionsOrFetch?: { limit?: number; cursor?: string | null; includeForks?: boolean } | Fetch,
    customFetch?: Fetch,
  ) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.includeForks) params.set("includeForks", "1");
    const query = params.toString();
    return this.transport.request<SpaceSessionsResponse>(
      `/api/spaces/${this.spaceId}/sessions${query ? `?${query}` : ""}`,
      {
        fetch,
      },
    );
  }

  byId(sessionId: string) {
    return new SessionClient(this.spaceId, sessionId, this.transport, this.websocketClient);
  }
}

export type WebSocketConnectionState = {
  state: "connecting" | "reconnecting" | "open" | "closed" | "error";
  willReconnect: boolean;
  connectionId?: string | null;
  attempt?: number;
  delayMs?: number;
  recoverable?: boolean;
};

export class SpacePresenceApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get(customFetch?: Fetch) {
    return this.transport.request<SpacePresenceSnapshot>(
      `/api/spaces/${this.spaceId}/presence`,
      { fetch: customFetch },
    );
  }
}

export class SpaceEventsApi {
  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
  ) {}

  subscribe(handler: (event: WebsocketEventPayload) => void) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const releaseRoom = this.websocketClient.retainRooms([getRealtimeSpaceRoom(this.spaceId)]);
    const offEvent = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId) return;
      handler(event);
    });
    return () => {
      offEvent();
      releaseRoom();
    };
  }

  on(type: SpaceEventName, handler: (event: WebsocketEventPayload) => void) {
    return this.subscribe((event) => {
      if (type === "event") {
        handler(event);
        return;
      }
      if (type === "fs.changed" && event.type === "space.fs.changed") {
        handler(event);
        return;
      }
      if (type === "ports.changed" && event.type === "space.ports.changed") {
        handler(event);
        return;
      }
      if (type === "presence.updated" && event.type === "space.presence.updated") {
        handler(event);
        return;
      }
      if (type === "canvas.tx.applied" && event.type === "canvas.tx.applied") {
        handler(event);
        return;
      }
      if (type === "canvas.tx.ack" && event.type === "canvas.tx.ack") {
        handler(event);
        return;
      }
      if (type === "canvas.tx.error" && event.type === "canvas.tx.error") {
        handler(event);
        return;
      }
      if (type === "task.created" && event.type === "task.created") {
        handler(event);
        return;
      }
      if (type === "task.updated" && event.type === "task.updated") {
        handler(event);
        return;
      }
      if (toSessionEventName(event.type) === type) handler(event);
    });
  }
}

export class SpaceMembersApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ items: SpaceMember[] }>(
      `/api/spaces/${this.spaceId}/members`,
    );
  }

  update(userId: string, role: SpaceRole) {
    return this.transport.request<SpaceMember>(
      `/api/spaces/${this.spaceId}/members`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      },
    );
  }

  remove(userId: string) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/members`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
  }
}

export class SpaceAccessApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get() {
    return this.transport.request<SpaceAccessPolicy>(
      `/api/spaces/${this.spaceId}/access`,
    );
  }

  set(body: { signed_in_user?: SpaceRole | null; anonymous_user?: SpaceRole | null }) {
    return this.transport.request<SpaceAccessPolicy>(
      `/api/spaces/${this.spaceId}/access`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
}

export class SpaceUsageApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get(days = 30, customFetch?: Fetch) {
    const params = new URLSearchParams({ days: String(days) });
    return this.transport.request<SpaceUsageResponse>(
      `/api/spaces/${this.spaceId}/usage?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

export type SpaceChannelBindingRecord = {
  id: string;
  spaceId: string;
  channelId: string;
  config: Record<string, unknown> | null;
  createdAt: string;
  channel: {
    id: string;
    userUuid: string;
    provider: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null;
};

export class SpaceChannelsApi {

  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<SpaceChannelBindingRecord[]>(
      `/api/spaces/${this.spaceId}/channels`,
    );
  }

  bind(channelId: string, config?: Record<string, unknown> | null) {
    return this.transport.request<SpaceChannelBindingRecord>(
      `/api/spaces/${this.spaceId}/channels/${channelId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: config ?? null }),
      },
    );
  }

  unbind(channelId: string) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/channels/${channelId}`,
      { method: "DELETE" },
    );
  }
}

export class SpaceModsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ items: SpaceModListItem[] }>(
      `/api/spaces/${this.spaceId}/mods`,
    );
  }

  create(input: { modSpaceId: string; name?: string | null; mountSlug?: string | null }) {
    return this.transport.request<{ item: SpaceModListItem; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  update(modId: string, input: { name?: string | null; mountSlug?: string; enabled?: boolean; sortOrder?: number }) {
    return this.transport.request<{ item: SpaceModListItem; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/${modId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  remove(modId: string) {
    return this.transport.request<{ ok: true; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/${modId}`,
      { method: "DELETE" },
    );
  }

  reorder(ids: string[]) {
    return this.transport.request<{ items: SpaceModListItem[]; sandboxRestarting: boolean }>(
      `/api/spaces/${this.spaceId}/mods/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      },
    );
  }
}

export class SpaceEnvApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env`,
    );
  }

  create(input: SpaceEnvInput) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  update(name: string, value: string) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
  }

  remove(name: string) {
    return this.transport.request<{ env: SpaceEnvInput[] }>(
      `/api/spaces/${this.spaceId}/env/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }
}

export type SpaceSandboxRecord = {
  status: string | null;
  runtimeStatus?: string | null;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  lastHeartbeatAt?: string | null;
  lastActivityAt?: string | null;
  reportedAt?: string | null;
  stoppedAt?: string | null;
  stopReason?: string | null;
  meta?: Record<string, unknown> | null;
};

export class SpaceSandboxApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  get() {
    return this.transport.request<{ sandbox: SpaceSandboxRecord | null }>(
      `/api/spaces/${this.spaceId}/sandbox`,
    );
  }

  ports() {
    return this.transport.request<{ endpoints: SpacePublicEndpoints }>(
      `/api/spaces/${this.spaceId}/sandbox/ports`,
    );
  }

  recreate() {
    return this.transport.request<{
      ok: boolean;
      status?: string;
      verified?: boolean;
      checks?: Record<string, boolean> | null;
      message?: string;
    }>(`/api/spaces/${this.spaceId}/sandbox/recreate`, {
      method: "POST",
    });
  }
}

export type SpaceRunCommandResponse = { taskRunId: string };

export class SpaceLabelsApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  list() {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels`,
    );
  }

  create(labelRef: string) {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef }),
      },
    );
  }

  update(labelRef: string, input: { name?: string; parentRef?: string | null; rank?: number }) {
    return this.transport.request<{ label: LabelListItem }>(
      `/api/spaces/${this.spaceId}/labels/by-ref`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  delete(labelRef: string) {
    const params = new URLSearchParams({ ref: labelRef });
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/labels/by-ref?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  reorder(labelRefs: string[]) {
    return this.transport.request<{ labels: LabelListItem[] }>(
      `/api/spaces/${this.spaceId}/labels/reorder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRefs }),
      },
    );
  }

  listItems(labelRef: string, input?: { limit?: number; cursor?: string | null }) {
    const params = new URLSearchParams({ ref: labelRef });
    if (input?.limit) params.set("limit", String(input.limit));
    if (input?.cursor) params.set("cursor", input.cursor);
    return this.transport.request<{ items: LabelAssignmentListItem[]; pageInfo: LabelAssignmentPageInfo }>(
      `/api/spaces/${this.spaceId}/labels/items?${params.toString()}`,
    );
  }

  attach(labelRef: string, input: { resourceType: LabelResourceType; resourceRef: string }) {
    return this.transport.request<{ assignment: LabelAssignmentRecord }>(
      `/api/spaces/${this.spaceId}/labels/attach`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  detach(labelRef: string, input: { resourceType: LabelResourceType; resourceRef: string }) {
    return this.transport.request<{ ok: true }>(
      `/api/spaces/${this.spaceId}/labels/detach`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRef, ...input }),
      },
    );
  }

  getResourceLabels(resourceType: LabelResourceType, resourceRef: string) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
    );
  }

  patchResourceLabels(resourceType: LabelResourceType, resourceRef: string, input: PatchResourceLabelsInput) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<PatchResourceLabelsResponse>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  setResourceLabels(resourceType: LabelResourceType, resourceRef: string, labelRefs: string[]) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }>(
      `/api/spaces/${this.spaceId}/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelRefs }),
      },
    );
  }
}

export class SpaceCommerceApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  setup() {
    return this.transport.request<{ businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/setup`,
      { method: "POST" },
    );
  }

  listProducts() {
    return this.transport.request<{ products: import("../types.js").SpaceCommerceProduct[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products`,
    );
  }

  createProduct(input: {
    key?: string;
    name: string;
    description?: string;
    amountUsd: number;
    status?: "draft" | "active";
    visibility?: "public" | "private";
  }) {
    return this.transport.request<{ product: import("../types.js").SpaceCommerceProduct; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  updateProduct(productKey: string, input: {
    name?: string;
    description?: string | null;
    status?: "draft" | "active" | "archived";
    visibility?: "public" | "private";
  }) {
    return this.transport.request<{ product: import("../types.js").SpaceCommerceProduct; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/products/${encodeURIComponent(productKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  listBenefits() {
    return this.transport.request<{ benefits: import("../types.js").SpaceCommerceBenefit[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits`,
    );
  }

  createBenefit(input: {
    key?: string;
    name: string;
    description?: string;
    type?: "feature" | "credits";
    metadata?: Record<string, string | number | boolean>;
    amount?: number;
    expiresInDays?: number;
  }) {
    return this.transport.request<{ benefit: import("../types.js").SpaceCommerceBenefit; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  updateBenefit(benefitKey: string, input: {
    name?: string;
    description?: string | null;
    status?: "active" | "archived";
    metadata?: Record<string, string | number | boolean>;
  }) {
    return this.transport.request<{ benefit: import("../types.js").SpaceCommerceBenefit; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/benefits/${encodeURIComponent(benefitKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  listProductBenefits() {
    return this.transport.request<{ productBenefits: import("../types.js").SpaceCommerceProductBenefitBinding[]; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits`,
    );
  }

  bindProductBenefit(input: { productKey: string; benefitKey: string }) {
    return this.transport.request<{ productBenefit: import("../types.js").SpaceCommerceProductBenefitBinding; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  unbindProductBenefit(input: { productKey: string; benefitKey: string }) {
    const params = new URLSearchParams({ productKey: input.productKey, benefitKey: input.benefitKey });
    return this.transport.request<{ ok: true; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/product-benefits?${params.toString()}`,
      { method: "DELETE" },
    );
  }

  listOrders(input?: { page?: number; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.page) params.set("page", String(input.page));
    if (input?.limit) params.set("limit", String(input.limit));
    return this.transport.request<{ orders: import("../types.js").SpaceCommerceOrder[]; pagination: { hasMore: boolean; nextPage: number | null }; businessKey: string }>(
      `/api/spaces/${this.spaceId}/commerce/orders${params.toString() ? `?${params.toString()}` : ""}`,
    );
  }
}

export class SpaceCanvasApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
  ) {}

  create(input: CanvasCreateInput) {
    return this.transport.request<CanvasBootstrapResponse>(
      `/api/spaces/${this.spaceId}/canvas`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getByPath(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<{ document: CanvasDocumentRecord }>(
      `/api/spaces/${this.spaceId}/canvas/by-path?${params.toString()}`,
      { fetch: customFetch },
    );
  }

  bootstrap(documentId: string, customFetch?: Fetch) {
    return this.transport.request<CanvasBootstrapResponse>(
      `/api/spaces/${this.spaceId}/canvas/${documentId}/bootstrap`,
      { fetch: customFetch },
    );
  }

  sendTransaction(documentId: string, input: CanvasTransactionInput) {
    return this.transport.request<CanvasBootstrapResponse>(
      `/api/spaces/${this.spaceId}/canvas/${documentId}/ops`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

}

export class SpaceCheckpointFilesApi {
  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    private readonly checkpointId: string,
  ) {}

  list(path = "", customFetch?: Fetch) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    const query = params.toString();
    return this.transport.request<SpaceFsTreeResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/tree${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }

  read(path: string, customFetch?: Fetch) {
    const params = new URLSearchParams({ path });
    return this.transport.request<SpaceFsFileResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.checkpointId}/fs/file?${params.toString()}`,
      { fetch: customFetch },
    );
  }
}

export class SpaceCheckpointApi {
  readonly files: SpaceCheckpointFilesApi;

  constructor(
    private readonly transport: HttpTransport,
    private readonly spaceId: string,
    readonly id: string,
  ) {
    this.files = new SpaceCheckpointFilesApi(transport, spaceId, id);
  }

  get(customFetch?: Fetch) {
    return this.transport.request<SpaceCheckpointDetailResponse>(
      `/api/spaces/${this.spaceId}/checkpoints/${this.id}`,
      { fetch: customFetch },
    );
  }
}

export type CheckpointListPageInfo = { hasMore: boolean; nextCursor: string | null };
export type CheckpointListOptions = { limit?: number; cursor?: string | null };
export type CheckpointListResponse = { checkpoints: CheckpointRecord[]; pageInfo?: CheckpointListPageInfo };

export type SpaceCheckpointsApi = ((checkpointId: string) => SpaceCheckpointApi) & {
  checkpoint: (checkpointId: string) => SpaceCheckpointApi;
  latest: () => SpaceCheckpointApi;
  create: (description?: string | null) => Promise<{ ok: true; taskRunId: string; existing?: boolean }>;
  list: (options?: CheckpointListOptions) => Promise<CheckpointListResponse>;
  get: (checkpointId: string, customFetch?: Fetch) => Promise<SpaceCheckpointDetailResponse>;
};

function createSpaceCheckpointsApi(transport: HttpTransport, spaceId: string): SpaceCheckpointsApi {
  const checkpoint = (checkpointId: string) => new SpaceCheckpointApi(transport, spaceId, checkpointId);
  return Object.assign(checkpoint, {
    checkpoint,
    latest: () => checkpoint("latest"),
    create: (description?: string | null) => transport.request<{ ok: true; taskRunId: string; existing?: boolean }>(
      `/api/spaces/${spaceId}/checkpoints`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description ?? null }),
      },
    ),
    list: (options?: CheckpointListOptions) => {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.cursor) params.set("cursor", options.cursor);
      const query = params.toString();
      return transport.request<CheckpointListResponse>(
        `/api/spaces/${spaceId}/checkpoints${query ? `?${query}` : ""}`,
      );
    },
    get: (checkpointId: string, customFetch?: Fetch) => checkpoint(checkpointId).get(customFetch),
  });
}

export class SpaceClient {
  readonly files: SpaceFilesApi;
  readonly sessions: SpaceSessionsApi;
  readonly members: SpaceMembersApi;
  readonly presence: SpacePresenceApi;
  readonly access: SpaceAccessApi;
  readonly checkpoints: SpaceCheckpointsApi;
  readonly usage: SpaceUsageApi;
  readonly channels: SpaceChannelsApi;
  readonly mods: SpaceModsApi;
  readonly env: SpaceEnvApi;
  readonly sandbox: SpaceSandboxApi;
  readonly invitations: SpaceInvitationsApi;
  readonly labels: SpaceLabelsApi;
  readonly canvas: SpaceCanvasApi;
  readonly commerce: SpaceCommerceApi;

  constructor(
    readonly id: string,
    private readonly transport: HttpTransport,
    private readonly websocketClient: WebsocketClient | null,
  ) {
    this.files = new SpaceFilesApi(transport, id);
    this.sessions = new SpaceSessionsApi(transport, id, websocketClient);
    this.members = new SpaceMembersApi(transport, id);
    this.presence = new SpacePresenceApi(transport, id);
    this.access = new SpaceAccessApi(transport, id);
    this.checkpoints = createSpaceCheckpointsApi(transport, id);
    this.usage = new SpaceUsageApi(transport, id);
    this.channels = new SpaceChannelsApi(transport, id);
    this.mods = new SpaceModsApi(transport, id);
    this.env = new SpaceEnvApi(transport, id);
    this.sandbox = new SpaceSandboxApi(transport, id);
    this.invitations = new SpaceInvitationsApi(transport, id);
    this.labels = new SpaceLabelsApi(transport, id);
    this.canvas = new SpaceCanvasApi(transport, id);
    this.commerce = new SpaceCommerceApi(transport, id);
  }

  get(customFetch?: Fetch) {
    return this.transport.request<SpaceRecord>(`/api/spaces/${this.id}`, {
      fetch: customFetch,
    });
  }

  prompt(input: CreateSpacePromptInput) {
    return this.transport.request<CreateSpacePromptResponse>(
      `/api/spaces/${this.id}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  update(input: { name?: string; slug?: string | null }) {
    return this.transport.request<{ space: SpaceRecord }>(`/api/spaces/${this.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  }

  rename(name: string) {
    return this.update({ name });
  }

  async sendCanvasTransactionRealtime(documentId: string, input: CanvasTransactionInput) {
    if (!this.websocketClient) return this.canvas.sendTransaction(documentId, input);
    const requestId = `canvas-${input.txId}`;
    const result = new Promise<{ document: { version: number } }>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        cleanupAck?.();
        cleanupError?.();
        fn();
      };
      const cleanupAck = this.websocketClient?.on("event", (event) => {
        if (event.type !== "canvas.tx.ack" || event.requestId !== requestId) return;
        const version = event.payload.version;
        settle(() => {
          if (typeof version === "number") resolve({ document: { version } });
          else reject(new Error("Invalid canvas ack"));
        });
      });
      const cleanupError = this.websocketClient?.on("event", (event) => {
        if (event.type !== "canvas.tx.error" || event.requestId !== requestId) return;
        settle(() => reject(new Error(typeof event.payload.message === "string" ? event.payload.message : "Canvas sync failed")));
      });
      timeout = setTimeout(() => settle(() => reject(new Error("Canvas sync timed out"))), 15_000);
    });
    await this.websocketClient.sendCanvasTransaction({
      spaceId: this.id,
      documentId,
      txId: input.txId,
      baseVersion: input.baseVersion ?? null,
      clientId: input.clientId ?? null,
      undoGroupId: input.undoGroupId ?? null,
      ops: input.ops,
      requestId,
    });
    return result;
  }

  profile(body: { description?: string | null; avatarUrl?: string | null }) {
    return this.transport.request<{ space: SpaceRecord }>(
      `/api/spaces/${this.id}/profile`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  runCommand(input: { command: string }) {
    return this.transport.request<SpaceRunCommandResponse>(
      `/api/spaces/${this.id}/commands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getConfig() {
    return this.transport.request<SpaceConfigResponse>(
      `/api/spaces/${this.id}/config`,
    );
  }

  updateConfig(input: SpaceConfigInput) {
    return this.transport.request<{ space: SpaceRecord }>(
      `/api/spaces/${this.id}/config`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  session(sessionId: string) {
    return new SessionClient(this.id, sessionId, this.transport, this.websocketClient);
  }

  updatePresence(meta?: Record<string, unknown> | null) {
    if (!this.websocketClient) return Promise.resolve();
    return this.websocketClient.updatePresence({ spaceId: this.id, meta: meta ?? null });
  }

  subscribe(handler: (event: WebsocketEventPayload) => void) {
    return new SpaceEventsApi(this.websocketClient, this.id).subscribe(handler);
  }

  on(type: SpaceEventName, handler: (event: WebsocketEventPayload) => void) {
    return new SpaceEventsApi(this.websocketClient, this.id).on(type, handler);
  }
}
