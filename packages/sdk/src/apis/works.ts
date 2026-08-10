import type { HttpTransport } from "../transport.js";
import type { RequestSource } from "@cohub/protocol/provenance";
import type { WorkArtifactDescriptor, WorkContentKind } from "@cohub/protocol";
import type { Permission, SpacePublicProfile } from "../types.js";

export type WorkTargetType = "file" | "directory" | "port";
export type WorkStatus = "published" | "disabled";
export type WorkVisibility = "public" | "space";

export type WorkPresentationMeta = {
  hideCohubBar?: boolean;
};

/** Snapshot of fields extracted from the published page head. */
export type WorkExtractedPageMeta = {
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  image?: string | null;
  lang?: string | null;
  themeColor?: string | null;
  sourcePath?: string | null;
  extractedAt?: string | null;
};

/**
 * Work presentation metadata.
 * `title` / `description` / `icon` / `image` / `lang` / `themeColor`
 * power public page head, share cards, and lists.
 */
export type WorkMeta = Record<string, unknown> & {
  title?: string;
  /** @deprecated Prefer `title`. Kept for older clients. */
  name?: string;
  description?: string;
  icon?: string;
  image?: string;
  /** BCP 47 language tag from the published page (e.g. zh-CN). */
  lang?: string;
  /** CSS color from meta theme-color. */
  themeColor?: string;
  presentation?: WorkPresentationMeta;
  extracted?: WorkExtractedPageMeta;
  source?: RequestSource;
};

export type WorkRecord = {
  id: string;
  spaceId: string;
  userUuid: string;
  slug: string;
  status: WorkStatus;
  visibility: WorkVisibility;
  targetType: WorkTargetType;
  targetRef: string;
  assetKey: string | null;
  currentVersionId: string | null;
  latestVersion: number;
  publishedAt: string | null;
  workScopes: Permission[];
  allowedViewerScopes: Permission[];
  meta: WorkMeta | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkCreateInput = {
  spaceId: string;
  slug: string;
  status?: WorkStatus;
  visibility?: WorkVisibility;
  targetType: WorkTargetType;
  targetRef: string;
  assetKey?: string | null;
  workScopes?: Permission[];
  allowedViewerScopes?: Permission[];
  meta?: WorkMeta | null;
};

export type WorkUpdateInput = Partial<{
  slug: string;
  status: WorkStatus;
  visibility: WorkVisibility;
  targetType: WorkTargetType;
  targetRef: string;
  workScopes: Permission[];
  allowedViewerScopes: Permission[];
  meta: WorkMeta | null;
}>;

export type WorkVersionRecord = {
  id: string;
  workId: string;
  version: number;
  targetType: WorkTargetType;
  targetRef: string;
  assetKey: string | null;
  contentKind: WorkContentKind;
  artifact: WorkArtifactDescriptor | null;
  meta: WorkMeta | null;
  createdAt: string | null;
};

export type WorkContentDownload = {
  manifestUrl: string;
  manifestSha256: string;
};

export type WorkContent =
  | { kind: "port"; url: string; targetType: "port"; port: string }
  | ((
      | { kind: "web"; url: string; targetType: "file" | "directory"; path: string }
      | {
          kind: "file";
          url: string;
          targetType: "file";
          path: string;
          name: string;
          mimeType: string | null;
          sizeBytes: number;
          sha256: string;
        }
    ) & {
      download?: WorkContentDownload;
    })
  | {
      kind: "board";
      url: string;
      targetType: "file";
      path: string;
      boardId: string;
      boardVersion: number;
    };

export type WorkPublicSpaceRecord = {
  id: string;
  slug: string;
  name: string | null;
  userUuid: string;
  publicProfile?: SpacePublicProfile | null;
};

export type WorkPublicOwnerRecord = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type WorkDetailResponse = {
  work: WorkRecord;
  space: WorkPublicSpaceRecord;
  owner: WorkPublicOwnerRecord;
  publicUrl: string | null;
  content: WorkContent | null;
};

export type WorkGetResponse = WorkDetailResponse;

export type WorkResolveResponse = WorkDetailResponse;

export type WorkViewSource = "web" | "cli" | "api";

export type WorkViewStatsResponse = {
  summary: {
    totalViews: number;
    views24h: number;
    views7d: number;
    views30d: number;
  };
  daily: Array<{ date: string; views: number }>;
  sources: Array<{ source: WorkViewSource; views: number }>;
};

export type WorkSessionResponse = {
  token: string;
  expiresIn: number;
  work: WorkRecord;
};

export type WorkAuthorizeResponse = {
  token: string;
  expiresIn: number;
  grant: {
    id: string;
    scopes: Permission[];
    expiresAt: string;
  };
};

export class WorksApi {
  constructor(private readonly transport: HttpTransport) {}

  listBySpace(spaceId: string) {
    return this.transport.request<{ works: WorkRecord[] }>(`/api/works/space/${spaceId}`);
  }

  get(id: string) {
    return this.transport.request<WorkGetResponse>(`/api/works/${id}`);
  }

  /**
   * Loads a published work's metadata + owner info by id (public access model).
   * Used by the standalone work auth broker page.
   */
  getPublicById(id: string) {
    return this.transport.request<WorkResolveResponse>(`/api/works/${id}/public`);
  }

  getBySlug(
    username: string,
    spaceSlug: string,
    workSlug: string,
    options?: { signal?: AbortSignal },
  ) {
    return this.transport.request<WorkResolveResponse>(
      `/api/works/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(spaceSlug)}/${encodeURIComponent(workSlug)}`,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  create(input: WorkCreateInput) {
    return this.transport.request<{ work: WorkRecord }>("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  update(id: string, input: WorkUpdateInput) {
    return this.transport.request<{ work: WorkRecord }>(`/api/works/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  delete(id: string) {
    return this.transport.request<{ ok: true }>(`/api/works/${id}`, {
      method: "DELETE",
    });
  }

  getStats(workId: string) {
    return this.transport.request<WorkViewStatsResponse>(`/api/works/${workId}/stats`);
  }

  listVersions(workId: string) {
    return this.transport.request<{ versions: WorkVersionRecord[] }>(`/api/works/${workId}/versions`);
  }

  publishVersion(workId: string, input?: { meta?: WorkMeta | null }) {
    return this.transport.request<{ work: WorkRecord; version: WorkVersionRecord }>(`/api/works/${workId}/versions`, {
      method: "POST",
      headers: input ? { "Content-Type": "application/json" } : undefined,
      body: input ? JSON.stringify(input) : undefined,
    });
  }

  createSession(workId: string) {
    return this.transport.request<WorkSessionResponse>(`/api/works/${workId}/session`, {
      method: "POST",
    });
  }

  authorize(workId: string, input: { scopes: Permission[]; reason?: string }) {
    return this.transport.request<WorkAuthorizeResponse>(`/api/works/${workId}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
}
