import { HttpError, type HttpTransport, type Fetch } from "../transport.js";
import type { LabelAssignmentRecord, LabelResourceType, MeResponse, SessionRecord, SessionSpaceRecord, UserProfile, UserRulesResponse, UserSessionsResponse, SpaceUsageResponse } from "../types.js";

export class UserApi {
  readonly labels: UserLabelsApi;

  constructor(
    private readonly transport: HttpTransport,
    private readonly transportBaseUrl: string,
    private readonly setStoredAuthToken?: (token: string) => void,
    private readonly clearStoredAuthToken?: () => void,
  ) {
    this.labels = new UserLabelsApi(transport);
  }

  getMe(
    options?: Fetch | { fetch?: Fetch; skipUnauthorizedHandler?: boolean },
  ) {
    const init =
      typeof options === "function" ? { fetch: options } : options;
    return this.transport.request<MeResponse>("/api/me", init);
  }

  updateProfile(input: { displayName?: string; avatarUrl?: string | null; username?: string | null }) {
    return this.transport.request<{ profile: UserProfile }>("/api/me/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  getRules(customFetch?: Fetch) {
    return this.transport.request<UserRulesResponse>("/api/me/rules", {
      method: "GET",
      fetch: customFetch,
    });
  }

  listSessions(optionsOrFetch?: { limit?: number; cursor?: string | null } | Fetch, customFetch?: Fetch) {
    const options = typeof optionsOrFetch === "function" ? undefined : optionsOrFetch;
    const fetch = typeof optionsOrFetch === "function" ? optionsOrFetch : customFetch;
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return this.transport.request<UserSessionsResponse>(
      `/api/me/sessions${query ? `?${query}` : ""}`,
      { fetch },
    );
  }

  getSession(sessionId: string, customFetch?: Fetch) {
    return this.transport.request<{ space: SessionSpaceRecord; session: SessionRecord }>(
      `/api/sessions/${sessionId}`,
      { fetch: customFetch },
    );
  }

  getUsage(days = 30, customFetch?: Fetch) {
    const params = new URLSearchParams({ days: String(days) });
    return this.transport.request<SpaceUsageResponse>(
      `/api/me/usage?${params.toString()}`,
      { fetch: customFetch },
    );
  }

  async setAuthToken(token: string) {
    const trimmedToken = token.trim();
    const response = await fetch(
      this.transportBaseUrl ? `${this.transportBaseUrl}/api/me` : "/api/me",
      {
        headers: {
          Authorization: `Bearer ${trimmedToken}`,
        },
      },
    );

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => response.statusText);
      const message =
        typeof body === "string" ? body : JSON.stringify(body ?? null);
      throw new HttpError(message || response.statusText, response.status, body);
    }

    this.setStoredAuthToken?.(trimmedToken);
    return response.json();
  }

  async clearAuthToken() {
    this.clearStoredAuthToken?.();
    return null;
  }
}

/** User-scoped labels — same label/assignment model as space labels, but private to the viewer. */
export class UserLabelsApi {
  constructor(private readonly transport: HttpTransport) {}

  getResourceLabels(resourceType: LabelResourceType, resourceRef: string) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ assignments: LabelAssignmentRecord[] }>(
      `/api/me/resources/${resourceType}/labels?${params.toString()}`,
    );
  }

  patchResourceLabels(resourceType: LabelResourceType, resourceRef: string, input: { addLabelRefs?: string[]; removeLabelRefs?: string[] }) {
    const params = new URLSearchParams({ resourceRef });
    return this.transport.request<{ assignments: LabelAssignmentRecord[] }>(
      `/api/me/resources/${resourceType}/labels?${params.toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }
}
