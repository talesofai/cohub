/**
 * Shared MIME helpers for space file read/write and CDN delivery classification.
 * Kept separate from space-fs.ts so CDN helpers can use them without cycles.
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
