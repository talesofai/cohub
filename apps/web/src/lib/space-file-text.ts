import { BOARD_MIME_TYPE, isBoardPath } from "@cohub/protocol";
import type { SpaceFsFileResponse } from "@neta-art/cohub";

/** Strip parameters (`text/plain; charset=utf-8` → `text/plain`) and lowercase. */
export function normalizeMime(
	mimeType: string | null | undefined,
): string | null {
	if (!mimeType) return null;
	const base = mimeType.split(";")[0]?.trim().toLowerCase();
	return base || null;
}

/**
 * Classify text-like MIME types the same way the API does for Space FS reads.
 * Used by the browser to decide editor/preview handling, including URL-delivered
 * text files that arrive with empty content.
 */
export function isTextMime(mimeType: string | null | undefined) {
	const mime = normalizeMime(mimeType);
	if (!mime) return false;
	return (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/csv" ||
		mime === "application/xml" ||
		mime === "application/yaml" ||
		mime === "application/toml" ||
		mime === "application/sql" ||
		mime === "application/x-ndjson"
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

function basenameOf(path: string) {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** Dotfiles (.npmrc, .gitignore, …) are text config by convention. */
export function isDotfilePath(path: string) {
	const name = basenameOf(path);
	return name.startsWith(".") && name !== "." && name !== "..";
}

/** `.csv` filenames are text by convention, matching the server MIME map. */
export function isCsvPath(path: string) {
	return /\.csv$/i.test(path);
}

function looksLikeUtf8Text(bytes: Uint8Array) {
	if (bytes.length === 0) return true;
	// Reject obvious binary (NUL) and high control-char density.
	let control = 0;
	for (let i = 0; i < bytes.length; i += 1) {
		const b = bytes[i] ?? 0;
		if (b === 0) return false;
		if (b < 0x09 || (b > 0x0d && b < 0x20)) control += 1;
	}
	return control / bytes.length < 0.1;
}

/**
 * Recover text for misclassified inline binary responses (e.g. local sandbox
 * sniffing `.npmrc` as application/octet-stream).
 */
export function coerceInlineTextFile(
	file: SpaceFsFileResponse,
): SpaceFsFileResponse {
	if (isTextFileResponse(file)) {
		return file.kind === "text"
			? file
			: { ...file, kind: "text", encoding: "utf-8" };
	}
	if (file.delivery === "url") return file;
	if (file.encoding !== "base64" || !file.content) return file;
	const recoverable =
		isDotfilePath(file.path) ||
		isDotfilePath(file.name) ||
		isBoardPath(file.path) ||
		isBoardPath(file.name) ||
		isCsvPath(file.path) ||
		isCsvPath(file.name);
	if (!recoverable) return file;

	try {
		const binary = atob(file.content);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		if (!looksLikeUtf8Text(bytes)) return file;
		const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		const defaultMime =
			isBoardPath(file.path) || isBoardPath(file.name)
				? BOARD_MIME_TYPE
				: "text/plain";
		return {
			...file,
			kind: "text",
			encoding: "utf-8",
			mimeType: file.mimeType ?? defaultMime,
			content,
		};
	} catch {
		return file;
	}
}

/**
 * Hydrate text content for URL-delivered files so the editor can preview/edit.
 * Binary media stays as-is (img/video can use the URL directly).
 */
export async function resolveTextFileResponse(
	file: SpaceFsFileResponse,
): Promise<SpaceFsFileResponse> {
	const coerced = coerceInlineTextFile(file);
	if (!isTextFileResponse(coerced)) return coerced;
	if (coerced.content) {
		return coerced.kind === "text"
			? coerced
			: { ...coerced, kind: "text", encoding: "utf-8" };
	}
	if (coerced.delivery !== "url" || !coerced.url) return coerced;

	const response = await fetch(coerced.url);
	if (!response.ok) {
		throw new Error(`Failed to load file content (${response.status})`);
	}
	const content = await response.text();
	return {
		...coerced,
		kind: "text",
		encoding: "utf-8",
		content,
	};
}

/**
 * Best-effort hydrate: never throws. Returns `{ file, error }` so callers can
 * soft-fail into a usable panel surface.
 */
export async function tryResolveTextFileResponse(
	file: SpaceFsFileResponse,
): Promise<{ file: SpaceFsFileResponse; error: string | null }> {
	try {
		return { file: await resolveTextFileResponse(file), error: null };
	} catch (error) {
		return {
			file,
			error:
				error instanceof Error ? error.message : "Failed to load file content",
		};
	}
}
