import type { HttpTransport } from "../transport.js";
import type { Permission, SpacePublicProfile } from "../types.js";

export type WorkTargetType = "file" | "directory" | "port";
export type WorkStatus = "published" | "disabled";
export type WorkVisibility = "public" | "space";

export type WorkPresentationMeta = {
  hideCohubBar?: boolean;
};

export type WorkMeta = Record<string, unknown> & {
  presentation?: WorkPresentationMeta;
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
  createdAt: string | null;
};

export type WorkContent =
  | { url: string; targetType: "port"; port: string }
  | { url: string; targetType: WorkTargetType; path: string };

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

  getBySlug(username: string, spaceSlug: string, workSlug: string) {
    return this.transport.request<WorkResolveResponse>(
      `/api/works/by-slug/${encodeURIComponent(username)}/${encodeURIComponent(spaceSlug)}/${encodeURIComponent(workSlug)}`,
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

  listVersions(workId: string) {
    return this.transport.request<{ versions: WorkVersionRecord[] }>(`/api/works/${workId}/versions`);
  }

  publishVersion(workId: string) {
    return this.transport.request<{ work: WorkRecord; version: WorkVersionRecord }>(`/api/works/${workId}/versions`, {
      method: "POST",
    });
  }

  purgeHistoricalAssets(workId: string) {
    return this.transport.request<{ ok: true; purgedVersions: number; deletedAssets: number }>(
      `/api/works/${workId}/purge-historical-assets`,
      { method: "POST" },
    );
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
