import type { Fetch, HttpTransport } from "../transport.js";
import type {
  GlobalSearchResponse,
  GlobalSearchType,
  PaletteOverviewResponse,
} from "../types.js";

export class SearchApi {
  constructor(private readonly transport: HttpTransport) {}

  query(
    input: {
      q: string;
      limit?: number;
      types?: GlobalSearchType[];
      spaceId?: string;
      labelRef?: string;
      /** Keep raw turn-level rows instead of one best turn per session. */
      groupTurns?: boolean;
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams({ q: input.q });
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    for (const type of input.types ?? []) params.append("type", type);
    if (input.spaceId) params.set("spaceId", input.spaceId);
    if (input.labelRef) params.set("labelRef", input.labelRef);
    if (input.groupTurns === false) params.set("groupTurns", "false");
    return this.transport.request<GlobalSearchResponse>(`/api/search?${params.toString()}`, {
      fetch: customFetch,
    });
  }

  /** Default (empty-query) command palette data: viewer-relative space signals. */
  overview(
    input?: {
      spaceLimit?: number;
      sessionLimit?: number;
      /** Local recent spaces to include in the server candidate set. */
      recentSpaceIds?: string[];
    },
    customFetch?: Fetch,
  ) {
    const params = new URLSearchParams();
    if (input?.spaceLimit !== undefined) params.set("spaceLimit", String(input.spaceLimit));
    if (input?.sessionLimit !== undefined)
      params.set("sessionLimit", String(input.sessionLimit));
    for (const spaceId of input?.recentSpaceIds ?? [])
      params.append("recentSpaceId", spaceId);
    const query = params.toString();
    return this.transport.request<PaletteOverviewResponse>(
      `/api/palette/overview${query ? `?${query}` : ""}`,
      { fetch: customFetch },
    );
  }
}
