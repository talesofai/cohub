export type WorkspacePreviewKind = "file" | "board" | "port" | "work";

export type WorkspacePreviewRef = {
	kind: WorkspacePreviewKind;
	key: string;
};

export const PREVIEW_QUERY_KEY = "preview";

/** Work preview keys are Work ids. */
const WORK_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidWorkKey(key: string): boolean {
	return WORK_ID_RE.test(key);
}

/** Accept only integer ports in 1..65535. Reject host-injection forms. */
export function isValidPortKey(key: string): boolean {
	if (!/^\d{1,5}$/.test(key)) return false;
	const n = Number(key);
	return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function encodePreviewParam(ref: WorkspacePreviewRef): string {
	return `${ref.kind}:${ref.key}`;
}

export function parsePreviewParam(
	value: string | null | undefined,
): WorkspacePreviewRef | null {
	if (!value) return null;
	const separator = value.indexOf(":");
	if (separator <= 0) return null;
	const kind = value.slice(0, separator);
	const key = value.slice(separator + 1);
	if (!key) return null;
	if (kind !== "file" && kind !== "board" && kind !== "port" && kind !== "work")
		return null;
	if (kind === "port" && !isValidPortKey(key)) return null;
	if (kind === "work" && !isValidWorkKey(key)) return null;
	return { kind, key };
}

export function readPreviewFromSearch(
	search: string | URLSearchParams | null | undefined,
): WorkspacePreviewRef | null {
	if (!search) return null;
	const params =
		typeof search === "string"
			? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
			: search;
	return parsePreviewParam(params.get(PREVIEW_QUERY_KEY));
}

export function withPreviewParam(
	pathname: string,
	search: string | URLSearchParams | null | undefined,
	ref: WorkspacePreviewRef | null,
): string {
	const params =
		typeof search === "string"
			? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
			: new URLSearchParams(search ?? undefined);
	if (ref) params.set(PREVIEW_QUERY_KEY, encodePreviewParam(ref));
	else params.delete(PREVIEW_QUERY_KEY);
	const query = params.toString();
	return query ? `${pathname}?${query}` : pathname;
}

/**
 * Preserve the current `?preview=` when switching Main routes inside a space.
 * Chat/session navigation should only change the main panel, not collapse Files.
 */
export function withCurrentPreview(
	pathname: string,
	currentSearch?: string | URLSearchParams | null,
): string {
	if (typeof window === "undefined" && currentSearch == null) return pathname;
	const search =
		currentSearch ??
		(typeof window !== "undefined" ? window.location.search : null);
	const preview = readPreviewFromSearch(search);
	if (!preview) return pathname;
	return withPreviewParam(pathname, null, preview);
}

/**
 * Sidebar-driven Main navigation. Desktop keeps the open preview pane;
 * mobile drops it so the full-screen overlay does not cover the target.
 */
export function withSidebarMainPreview(
	pathname: string,
	options: {
		isMobile: boolean;
		currentSearch?: string | URLSearchParams | null;
	},
): string {
	if (options.isMobile) return pathname;
	return withCurrentPreview(pathname, options.currentSearch);
}

/** Deterministic ingress for legacy `/spaces/:id/files/...` routes. */
export function buildFileIngressMainRoute(
	spaceId: string,
	path: string,
): string {
	const cleaned = path
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.filter(Boolean)
		.join("/");
	return withPreviewParam(`/spaces/${spaceId}/sessions/new`, null, {
		kind: "file",
		key: cleaned,
	});
}
