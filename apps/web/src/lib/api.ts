import { goto } from "$app/navigation";
import { PUBLIC_API_ORIGIN, PUBLIC_GATEWAY_ORIGIN } from "$env/static/public";
import {
  clearAuthToken as clearStoredAuthToken,
  getAuthToken,
  logtoClient,
  setAuthToken as setStoredAuthToken,
} from "$lib/auth";
import type {
  ContentBlock,
  SessionStreamEvent,
  SessionStreamError,
  SessionBindingRecord as ProtocolSessionBindingRecord,
  SessionRecord as ProtocolSessionRecord,
  MessageRecord,
  ChannelConfig,
  ResourcePermissionLevel,
  SpaceFsTreeResponse,
  SpaceFsFileResponse,
  SpaceFsWriteFileInput,
  SpaceFsMoveInput,
} from "@cohub/protocol";
export type {
  SessionStreamEvent,
  ChannelConfig,
  DiscordChannelConfig,
  ResourcePermissionLevel,
  SpaceFsTreeResponse,
  SpaceFsFileResponse,
} from "@cohub/protocol";

export type SpaceFsEntry = SpaceFsTreeResponse["entries"][number];
export type SpaceFsFileKind = SpaceFsFileResponse["kind"];
export type SpaceFsEncoding = SpaceFsFileResponse["encoding"];

const API_BASE_URL = PUBLIC_API_ORIGIN ?? "";
const GATEWAY_BASE_URL = PUBLIC_GATEWAY_ORIGIN ?? "";

type ApiError = {
  message: string;
};

type Fetch = typeof globalThis.fetch;

// ─── Re-export protocol types with web-specific extensions ───

export type { ContentBlock, MessageRecord };

export type SessionBindingRecord = ProtocolSessionBindingRecord;

/** Web-extended session record with computed fields from API responses */
export type SessionRecord = ProtocolSessionRecord & {
  bindings?: SessionBindingRecord[];
  totalMessages?: number;
  totalToolCalls?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: string | number | null;
  shareLevel?: ResourcePermissionLevel | null;
};

/** Space record — primary frontend domain object */
export type SpaceRecord = {
  id: string;
  userUuid: string;
  name: string;
  description: string | null;
  giteaRepoName: string;
  baseCheckpointId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  channels?: {
    id: string;
    name: string | null;
    provider: string;
    status: string;
  }[];
};

export type SpaceListItem = SpaceRecord;

export type SessionMessagesResponse = {
  space: SpaceRecord;
  session: SessionRecord;
  messages: MessageRecord[];
};

export type SessionMessagesPaginatedResponse = {
  space: SpaceRecord;
  session: SessionRecord;
  messages: MessageRecord[];
  hasMore: boolean;
  nextCursor: number | undefined;
};


const withAuthorization = async (init?: RequestInit): Promise<RequestInit> => {
  const headers = new Headers(init?.headers);
  const token = await getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.delete("Authorization");
  }

  return {
    ...init,
    headers,
  };
};

const apiFetch = async (
  path: string,
  init?: RequestInit & { fetch?: Fetch },
) => {
  const fetcher = init?.fetch ?? fetch;
  const url = API_BASE_URL ? `${API_BASE_URL}${path}` : path;

  const response = await fetcher(url, await withAuthorization(init));

  if (response.status === 401 && typeof window !== "undefined") {
    await logtoClient.signIn(`${window.location.origin}/callback`);
    throw new Error("unauthorized");
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const message = contentType.includes("application/json")
      ? JSON.stringify(await response.json().catch(() => null))
      : await response.text().catch(() => response.statusText);
    throw new Error(message || response.statusText);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
};

const gatewayFetch = async (
  path: string,
  init?: RequestInit & { fetch?: Fetch },
) => {
  const fetcher = init?.fetch ?? fetch;
  const url = GATEWAY_BASE_URL ? `${GATEWAY_BASE_URL}${path}` : path;

  const response = await fetcher(url, await withAuthorization(init));

  if (response.status === 401 && typeof window !== "undefined") {
    await logtoClient.signIn(`${window.location.origin}/`);
    throw new Error("unauthorized");
  }

  return response;
};

const readSseEvents = async function* (response: Response): AsyncGenerator<{ id?: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  const extractNextChunk = () => {
    const lfBoundary = buffer.indexOf("\n\n");
    const crlfBoundary = buffer.indexOf("\r\n\r\n");

    if (lfBoundary === -1 && crlfBoundary === -1) {
      return null;
    }

    if (
      crlfBoundary !== -1 &&
      (lfBoundary === -1 || crlfBoundary < lfBoundary)
    ) {
      const chunk = buffer.slice(0, crlfBoundary);
      buffer = buffer.slice(crlfBoundary + 4);
      return chunk;
    }

    const chunk = buffer.slice(0, lfBoundary);
    buffer = buffer.slice(lfBoundary + 2);
    return chunk;
  };

  const parseChunk = (chunk: string) => {
    const normalizedChunk = chunk.replace(/\r\n/g, "\n");
    const lines = normalizedChunk.split("\n");
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    const idLine = lines.find((line) => line.startsWith("id:"));

    return {
      id: idLine ? idLine.slice(3).replace(/^ /, "") : undefined,
      data: dataLines.join("\n"),
    };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let chunk = extractNextChunk();
    while (chunk !== null) {
      const parsed = parseChunk(chunk);
      if (parsed.data) {
        yield parsed;
      }
      chunk = extractNextChunk();
    }
  }

  buffer += decoder.decode();
  const trailing = parseChunk(buffer);
  if (trailing.data) {
    yield trailing;
  }
};

export const setAuthToken = async (token: string) => {
  const trimmedToken = token.trim();
  const response = await fetch(
    API_BASE_URL ? `${API_BASE_URL}/api/me` : "/api/me",
    {
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
      },
    },
  );

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const message = contentType.includes("application/json")
      ? JSON.stringify(await response.json().catch(() => null))
      : await response.text().catch(() => response.statusText);
    throw new Error(message || response.statusText);
  }

  setStoredAuthToken(trimmedToken);
  return response.json();
};

export const clearAuthToken = async () => {
  clearStoredAuthToken();
  return null;
};

export const getMe = async (customFetch?: Fetch) => {
  return apiFetch("/api/me", { fetch: customFetch });
};

export type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

export const getModels = async (customFetch?: Fetch) => {
  // Public endpoint — no auth required
  const fetcher = customFetch ?? fetch;
  const url = API_BASE_URL ? `${API_BASE_URL}/api/models` : "/api/models";
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<Record<string, ModelCatalogEntry[]>>;
};

export const getWorkspaceById = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/workspaces/${id}`, {
    fetch: customFetch,
  }) as Promise<WorkspaceByIdResponse>;
};

export const getWorkspaceTree = async (
  id: string,
  path = "",
  ref?: string,
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }
  if (ref) {
    params.set("ref", ref);
  }
  const query = params.toString();
  return apiFetch(`/api/workspaces/${id}/tree${query ? `?${query}` : ""}`, {
    fetch: customFetch,
  }) as Promise<Tree>;
};

export const getWorkspaceFile = async (
  id: string,
  path: string,
  ref?: string,
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams({ path });
  if (ref) {
    params.set("ref", ref);
  }
  return apiFetch(`/api/workspaces/${id}/file?${params.toString()}`, {
    fetch: customFetch,
  });
};

export const getSession = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/sessions/${id}`, {
    fetch: customFetch,
  }) as Promise<{ space: SpaceRecord; session: SessionRecord }>;
};


export const getSessionMessages = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/sessions/${id}/messages`, {
    fetch: customFetch,
  }) as Promise<SessionMessagesResponse>;
};

export const getSessionMessagesPaginated = async (
  id: string,
  options?: {
    cursor?: number;
    limit?: number;
    direction?: "older" | "newer";
  },
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams();
  if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.direction) params.set("direction", options.direction);
  const query = params.toString();
  return apiFetch(`/api/sessions/${id}/messages${query ? `?${query}` : ""}`, {
    fetch: customFetch,
  }) as Promise<SessionMessagesPaginatedResponse>;
};

export type { SessionStreamError };
export type SessionStreamEnvelope = {
  id?: string;
  event: SessionStreamEvent;
};

// ─── Simple client-side dedup: reject identical payload in same session within 2s ───
let lastSentSignature = "";
let lastSentSessionId = "";
let lastSentAt = 0;
const DEDUP_WINDOW_MS = 2000;

export const postSessionMessage = async (
  sessionId: string,
  content: ContentBlock[],
  options?: { model?: string; provider?: string },
) => {
  const signature = JSON.stringify({ sessionId, content, options });

  const now = Date.now();
  if (
    sessionId === lastSentSessionId &&
    signature === lastSentSignature &&
    now - lastSentAt < DEDUP_WINDOW_MS
  ) {
    throw new Error("Duplicate message ignored");
  }
  lastSentSessionId = sessionId;
  lastSentSignature = signature;
  lastSentAt = now;

  return apiFetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      model: options?.model,
      provider: options?.provider,
    }),
  }) as Promise<{ ok: true; userMessageId: string }>;
};

export const forkSession = async (
  id: string,
  input: { fromMessageId: string; title?: string | null },
) => {
  return apiFetch(`/api/sessions/${id}/fork`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  }) as Promise<{ ok: true; session: SessionRecord }>;
};

export type { ApiError };

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
    name: string;
  } | null;
};

export type WorkspaceListItem = {
  id: string;
  userUuid: string;
  ownerUserUuid: string;
  name: string;
  description: string | null;
  giteaRepoName: string;
  visibility: "public" | "private";
  parentId?: string | null;
  forkCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceForkInfo = {
  id: string;
  name: string;
  ownerUserUuid: string;
  ownerUsername: string | null;
};

export type WorkspaceDetail = WorkspaceListItem & {
  ownerUsername: string | null;
  cloneUrl: string | null;
  sshUrl: string | null;
  htmlUrl: string | null;
  fullName: string | null;
  forkedFrom: WorkspaceForkInfo | null;
  isOwner: boolean;
};

export type Workspace = WorkspaceListItem;

export type PublicWorkspace = WorkspaceListItem & {
  forkCount: number;
  parentId: string | null;
};

export type TreeEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
};

export type Tree = {
  repoOwner: string;
  repoName: string;
  path: string;
  ref: string | null;
  entries: TreeEntry[];
};

export type GiteaRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  ssh_url: string;
  html_url: string;
};

export const getChannels = async (customFetch?: Fetch) => {
  return apiFetch("/api/channels", {
    method: "GET",
    fetch: customFetch,
  }) as Promise<Channel[]>;
};

export const createChannel = async (data: {
  provider: string;
  name: string;
  credentials: Record<string, unknown>;
}) => {
  return apiFetch("/api/channels", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
};

export const deleteChannel = async (id: string) => {
  return apiFetch(`/api/channels/${id}`, { method: "DELETE" });
};

export const getWorkspaces = async (customFetch?: Fetch) => {
  return apiFetch("/api/workspaces", {
    method: "GET",
    fetch: customFetch,
  }) as Promise<WorkspaceListItem[]>;
};

export const createWorkspace = async (data: {
  name: string;
  description?: string;
  private?: boolean;
}) => {
  return apiFetch("/api/workspaces", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }) as Promise<WorkspaceDetail>;
};


export type SpaceCreateResponse = {
  space: SpaceRecord;
  session: SessionRecord;
};

export type SpaceEnvInput = {
  name: string;
  value: string;
};

export type SpaceChannelBindingInput = {
  channelId: string;
  config?: ChannelConfig | null;
};

export type SpaceChannelRecord = {
  id: string;
  spaceId: string;
  channelId: string;
  config?: ChannelConfig | null;
  createdAt: string;
  channel?: Channel | null;
};

export type SpaceSessionsResponse = {
  space: SpaceRecord;
  sessions: SessionRecord[];
};

export const createSpace = async (input?: {
  name?: string;
  description?: string | null;
  source?: string;
  cwd?: string;
  protocol?: "pi" | "acp" | "internal";
  meta?: Record<string, unknown>;
  extraEnv?: SpaceEnvInput[];
  channelBindings?: SpaceChannelBindingInput[];
}) => {
  return apiFetch("/api/spaces", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input ?? {}),
  }) as Promise<SpaceCreateResponse>;
};

export const getSpaces = async (customFetch?: Fetch) => {
  return apiFetch("/api/spaces", {
    method: "GET",
    fetch: customFetch,
  }) as Promise<SpaceRecord[]>;
};

export const getSpace = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/spaces/${id}`, {
    fetch: customFetch,
  }) as Promise<SpaceRecord>;
};

export const createSpaceSession = async (
  id: string,
  input?: {
    title?: string;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
  },
) => {
  return apiFetch(`/api/spaces/${id}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input ?? {}),
  }) as Promise<{ ok: true; session: SessionRecord }>;
};

export const getSpaceSessions = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/spaces/${id}/sessions`, {
    fetch: customFetch,
  }) as Promise<SpaceSessionsResponse>;
};

export const getSpaceChannels = async (id: string, customFetch?: Fetch) => {
  return apiFetch(`/api/spaces/${id}/channels`, {
    fetch: customFetch,
  }) as Promise<SpaceChannelRecord[]>;
};

export const getSpaceFsTree = async (
  spaceId: string,
  path = "",
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  const query = params.toString();
  return apiFetch(`/api/spaces/${spaceId}/fs/tree${query ? `?${query}` : ""}`, {
    fetch: customFetch,
  }) as Promise<SpaceFsTreeResponse>;
};

export const getSpaceFsFile = async (
  spaceId: string,
  path: string,
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams({ path });
  return apiFetch(`/api/spaces/${spaceId}/fs/file?${params.toString()}`, {
    fetch: customFetch,
  }) as Promise<SpaceFsFileResponse>;
};

export const getSpaceFsDownloadUrl = (
  spaceId: string,
  path: string,
): string => {
  const params = new URLSearchParams({ path });
  return `/api/spaces/${spaceId}/fs/download?${params.toString()}`;
};

export const triggerSpaceFsDownload = (
  spaceId: string,
  path: string,
) => {
  const url = getSpaceFsDownloadUrl(spaceId, path);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? "download";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const putSpaceFsFile = async (
  spaceId: string,
  input: SpaceFsWriteFileInput,
) => {
  return apiFetch(`/api/spaces/${spaceId}/fs/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }) as Promise<{ path: string; size: number; mtimeMs: number }>;
};

export const createSpaceFsDir = async (spaceId: string, path: string) => {
  return apiFetch(`/api/spaces/${spaceId}/fs/dir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }) as Promise<{ path: string; mtimeMs: number }>;
};

export const deleteSpaceFsNode = async (
  spaceId: string,
  path: string,
  recursive = false,
) => {
  const params = new URLSearchParams({ path });
  if (recursive) params.set("recursive", "true");
  return apiFetch(`/api/spaces/${spaceId}/fs/node?${params.toString()}`, {
    method: "DELETE",
  }) as Promise<{ path: string; deleted: true }>;
};

export const moveSpaceFsNode = async (
  spaceId: string,
  input: SpaceFsMoveInput,
) => {
  return apiFetch(`/api/spaces/${spaceId}/fs/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }) as Promise<{ fromPath: string; toPath: string }>;
};

export const updateSpaceChannelConfig = async (
  id: string,
  input: { config: ChannelConfig | null },
) => {
  return apiFetch(`/api/space-channels/${id}/config`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  }) as Promise<SpaceChannelRecord>;
};


export type PublicWorkspacesResponse = {
  items: PublicWorkspace[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export const getPublicWorkspaces = async (
  page = 1,
  limit = 20,
  search?: string,
  customFetch?: Fetch,
) => {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (search) {
    params.set("search", search);
  }
  return apiFetch(`/api/workspaces/public?${params.toString()}`, {
    fetch: customFetch,
  }) as Promise<PublicWorkspacesResponse>;
};

export type ForkWorkspaceResponse = WorkspaceDetail & {
  forkedFrom: WorkspaceForkInfo;
};

export const forkWorkspace = async (id: string, name?: string) => {
  return apiFetch(`/api/workspaces/${id}/fork`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(name ? { name } : {}),
  }) as Promise<ForkWorkspaceResponse>;
};

export type WorkspaceByIdResponse = WorkspaceDetail;

export const updateWorkspace = async (
  id: string,
  data: {
    name?: string;
    description?: string;
    visibility?: "public" | "private";
  },
) => {
  return apiFetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }) as Promise<WorkspaceDetail>;
};

export const deleteWorkspace = async (id: string) => {
  return apiFetch(`/api/workspaces/${id}`, {
    method: "DELETE",
  }) as Promise<null>;
};

export const deleteSpace = async (id: string) => {
  return apiFetch(`/api/spaces/${id}`, {
    method: "DELETE",
  }) as Promise<{ success: boolean }>;
};

// ─── SSH Key Management ──────────────────────────────

export type UserSshKey = {
  id: string;
  key: string;
  title: string;
  giteaKeyId: number;
  createdAt: string;
};

export const getSshKeys = async (customFetch?: Fetch) => {
  return apiFetch("/api/user/ssh-keys", {
    method: "GET",
    fetch: customFetch,
  }) as Promise<UserSshKey[]>;
};

export const createSshKey = async (data: { key: string; title: string }) => {
  return apiFetch("/api/user/ssh-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }) as Promise<UserSshKey>;
};

export const deleteSshKey = async (id: string) => {
  return apiFetch(`/api/user/ssh-keys/${id}`, {
    method: "DELETE",
  }) as Promise<{ ok: true }>;
};

// ─── Permission Management ──────────────────────────────

export type ResourcePermission = {
  id: string;
  resourceType: "space" | "session";
  resourceId: string;
  granteeUuid: string | null;
  level: ResourcePermissionLevel;
  createdBy: string;
  createdAt: string;
};

export const createSpacePermission = async (
  spaceId: string,
  level: ResourcePermissionLevel,
) =>
  apiFetch(`/api/spaces/${spaceId}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  }) as Promise<ResourcePermission>;

export const deleteSpacePermission = async (spaceId: string) =>
  apiFetch(`/api/spaces/${spaceId}/permissions`, { method: "DELETE" }) as Promise<{ ok: true }>;

export const listSpacePermissions = async (spaceId: string) =>
  apiFetch(`/api/spaces/${spaceId}/permissions`) as Promise<ResourcePermission[]>;

export const createSessionPermission = async (
  sessionId: string,
  level: ResourcePermissionLevel,
) =>
  apiFetch(`/api/sessions/${sessionId}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  }) as Promise<ResourcePermission>;

export const deleteSessionPermission = async (sessionId: string) =>
  apiFetch(`/api/sessions/${sessionId}/permissions`, { method: "DELETE" }) as Promise<{ ok: true }>;

// ─── Collaborator Management ──────────────────────────────

export const addSpaceCollaborator = async (
  spaceId: string,
  granteeUuid: string,
  level: ResourcePermissionLevel,
) =>
  apiFetch(`/api/spaces/${spaceId}/collaborators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ granteeUuid, level }),
  }) as Promise<ResourcePermission>;

export const listSpaceCollaborators = async (spaceId: string) =>
  apiFetch(`/api/spaces/${spaceId}/collaborators`) as Promise<ResourcePermission[]>;

export const updateSpaceCollaborator = async (
  spaceId: string,
  granteeUuid: string,
  level: ResourcePermissionLevel,
) =>
  apiFetch(`/api/spaces/${spaceId}/collaborators/${granteeUuid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  }) as Promise<ResourcePermission>;

export const removeSpaceCollaborator = async (spaceId: string, granteeUuid: string) =>
  apiFetch(`/api/spaces/${spaceId}/collaborators/${granteeUuid}`, {
    method: "DELETE",
  }) as Promise<{ ok: true }>;

// ─── SSE Streaming ──────────────────────────────

/**
 * Extract render state from ContentBlock[] for UI display.
 */
export function extractSessionRenderState(content: ContentBlock[]) {
  const thinkingBlocks = content.filter(
    (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking"
  );
  const textBlocks = content.filter(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text"
  );
  const toolUseBlocks = content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
  );

  const thinking = thinkingBlocks.map((b) => b.thinking).join("\n").trim();
  const answer = textBlocks.map((b) => b.text).join("\n").trim();
  const toolCalls = toolUseBlocks.map((b) => ({
    toolCallId: b.id,
    toolName: b.name,
    status: (b._meta as { toolStatus?: string } | undefined)?.toolStatus ?? "queued",
    summary: (b._meta as { summary?: string } | undefined)?.summary ?? "",
  }));

  return { thinking, answer, toolCalls };
}

export const streamSpaceEvents = async function* (
  spaceId: string,
  lastEventId?: string,
  signal?: AbortSignal,
): AsyncGenerator<SessionStreamEnvelope> {
  const url = API_BASE_URL
    ? `${API_BASE_URL}/api/spaces/${spaceId}/stream`
    : `/api/spaces/${spaceId}/stream`;

  const headers = new Headers();
  const token = await getAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (lastEventId) {
    headers.set("Last-Event-ID", lastEventId);
  }

  const response = await fetch(url, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Stream request failed: ${response.status} ${response.statusText}`);
  }

  for await (const sse of readSseEvents(response)) {
    try {
      yield { id: sse.id, event: JSON.parse(sse.data) as SessionStreamEvent };
    } catch {
      // Skip non-JSON events (e.g. "ready" event)
    }
  }
};

export const streamSessionEvents = async function* (
  sessionId: string,
  lastEventId?: string,
  signal?: AbortSignal,
): AsyncGenerator<SessionStreamEnvelope> {
  const url = API_BASE_URL
    ? `${API_BASE_URL}/api/sessions/${sessionId}/stream`
    : `/api/sessions/${sessionId}/stream`;

  const headers = new Headers();
  const token = await getAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (lastEventId) {
    headers.set("Last-Event-ID", lastEventId);
  }

  const response = await fetch(url, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Stream request failed: ${response.status} ${response.statusText}`);
  }

  for await (const sse of readSseEvents(response)) {
    try {
      yield { id: sse.id, event: JSON.parse(sse.data) as SessionStreamEvent };
    } catch {
      // Skip non-JSON events (e.g. "ready" event)
    }
  }
};

// ─── Cronjob & Task Runs ──────────────────────────────

export type CronJobRecord = {
  id: string;
  userUuid: string;
  title: string;
  taskType: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  bullJobKey: string;
  spaceId: string | null;
  sessionId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  userUuid: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateCronJobInput = {
  title: string;
  taskType: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone?: string;
  spaceId?: string;
  sessionId?: string;
};


export const getCronJobs = async () => {
  return apiFetch("/api/cron-jobs") as Promise<{ jobs: CronJobRecord[] }>;
};

export const createCronJob = async (data: CreateCronJobInput) => {
  return apiFetch("/api/cron-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }) as Promise<CronJobRecord>;
};

export const deleteCronJob = async (id: string) => {
  return apiFetch(`/api/cron-jobs/${id}`, { method: "DELETE" }) as Promise<{ ok: true }>;
};

export const toggleCronJob = async (id: string, enabled: boolean) => {
  return apiFetch(`/api/cron-jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }) as Promise<{ ok: true }>;
};

export const getCronJobRuns = async (cronJobId: string) => {
  return apiFetch(`/api/cron-jobs/${cronJobId}/runs`) as Promise<{ runs: TaskRunRecord[] }>;
};

export type CreateScheduledTaskInput = {
  taskType: string;
  payload: Record<string, unknown>;
  scheduleAt: string;
  spaceId?: string;
  sessionId?: string;
};


export const createScheduledTask = async (data: CreateScheduledTaskInput) => {
  return apiFetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }) as Promise<{ ok: true; jobId: string; scheduledAt: string }>;
};

export const getTaskRuns = async (filters?: {
  cronJobId?: string;
  spaceId?: string;
}) => {
  const params = new URLSearchParams();
  if (filters?.cronJobId) params.set("cronJobId", filters.cronJobId);
  if (filters?.spaceId) params.set("spaceId", filters.spaceId);
  const query = params.toString();
  return apiFetch(`/api/tasks/runs${query ? `?${query}` : ""}`) as Promise<{ runs: TaskRunRecord[] }>;
};

