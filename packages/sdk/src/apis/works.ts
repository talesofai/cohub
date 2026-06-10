import type { HttpTransport } from "../transport.js";
import type { Permission } from "../types.js";

export type WorkTargetType = "file" | "directory" | "port";
export type WorkStatus = "draft" | "published";

export type WorkRecord = {
  id: string;
  spaceId: string;
  userUuid: string;
  slug: string;
  status: WorkStatus;
  targetType: WorkTargetType;
  targetRef: string;
  assetKey: string | null;
  publishedAt: string | null;
  workScopes: Permission[];
  allowedViewerScopes: Permission[];
  meta: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkCreateInput = {
  spaceId: string;
  slug: string;
  status?: WorkStatus;
  targetType: WorkTargetType;
  targetRef: string;
  assetKey?: string | null;
  workScopes?: Permission[];
  allowedViewerScopes?: Permission[];
  meta?: Record<string, unknown> | null;
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

  getBySlug(username: string, spaceSlug: string, workSlug: string) {
    return this.transport.request<{
      work: WorkRecord;
      space: { id: string; slug: string | null; name: string | null; userUuid: string };
      owner: { userUuid: string; username: string | null; displayName: string };
    }>(
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
