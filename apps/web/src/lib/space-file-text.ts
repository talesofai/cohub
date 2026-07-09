import type { SpaceFsFileResponse } from "@neta-art/cohub";

/**
 * Classify text-like MIME types the same way the API does for Space FS reads.
 * Used by the browser to decide editor/preview handling, including URL-delivered
 * text files that arrive with empty content.
 */
export function isTextMime(mimeType: string | null | undefined) {
	if (!mimeType) return false;
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/yaml" ||
		mimeType === "application/toml" ||
		mimeType === "application/sql" ||
		mimeType === "application/x-ndjson"
	);
}

/**
 * Whether a file response should be treated as editable/previewable text.
 * Prefers explicit `kind: "text"`, and falls back to MIME for CDN URL responses
 * that historically arrived as binary placeholders.
 */
export function isTextFileResponse(
	file: Pick<SpaceFsFileResponse, "kind" | "mimeType"> | null | undefined,
) {
	if (!file) return false;
	return file.kind === "text" || isTextMime(file.mimeType);
}

/**
 * Hydrate text content for URL-delivered files so the editor can preview/edit.
 * Binary media stays as-is (img/video can use the URL directly).
 */
export async function resolveTextFileResponse(
	file: SpaceFsFileResponse,
): Promise<SpaceFsFileResponse> {
	if (!isTextFileResponse(file)) return file;
	if (file.content) {
		return file.kind === "text"
			? file
			: { ...file, kind: "text", encoding: "utf-8" };
	}
	if (file.delivery !== "url" || !file.url) return file;

	const response = await fetch(file.url);
	if (!response.ok) {
		throw new Error(`Failed to load file content (${response.status})`);
	}
	const content = await response.text();
	return {
		...file,
		kind: "text",
		encoding: "utf-8",
		content,
	};
}
