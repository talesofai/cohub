import type {
	BoardAudioItem,
	BoardFileItem,
	BoardFileSnapshot,
	BoardFrame,
	BoardImageItem,
	BoardItem,
	BoardItemStyle,
	BoardMediaSnapshot,
	BoardTaskItem,
	BoardTaskSnapshot,
	BoardVideoItem,
} from "@neta-art/cohub/board";
import {
	arrowFrame,
	computeDrawBounds,
	DEFAULT_BOARD_TOOL_STYLES,
	featuredTaskArtifact,
	fileBaseName,
	filePreviewKind,
	measureBoardText,
	TEXT_FONT_SIZE,
	unknownRealType,
} from "@neta-art/cohub/board";
import { createBoardItemId } from "$lib/board/board-id";
import { getResourceTitle, inferMediaKind } from "$lib/board/board-media";

const DEFAULT_MEDIA_SIZE = { width: 320, height: 200 };
const DEFAULT_TASK_SIZE = { width: 300, height: 188 };
const DEFAULT_TASK_MEDIA_SIZE = { width: 320, height: 180 };
/** Fallback for video with unknown intrinsic size: the common 16:9 aspect. */
const DEFAULT_VIDEO_SIZE = { width: 320, height: 180 };
const DEFAULT_AUDIO_SIZE = { width: 320, height: 112 };
/** Offset applied when duplicating so the copy is visibly displaced. */
export const DUPLICATE_OFFSET = 24;

export const DEFAULT_BOARD_ITEM_STYLE: BoardItemStyle = {
	variant: "default",
	size: "md",
	emphasis: "normal",
	effects: [],
};

function createFrame(
	x: number,
	y: number,
	size = DEFAULT_MEDIA_SIZE,
): BoardFrame {
	return { x, y, width: size.width, height: size.height, rotation: 0 };
}

/**
 * Fit media into a max edge while preserving aspect. Falls back to the default
 * media size when intrinsic dimensions are unknown.
 */
export function mediaFrameSize(
	naturalWidth?: number | null,
	naturalHeight?: number | null,
	maxEdge = 480,
	fallback = DEFAULT_MEDIA_SIZE,
): { width: number; height: number } {
	if (
		!naturalWidth ||
		!naturalHeight ||
		!Number.isFinite(naturalWidth) ||
		!Number.isFinite(naturalHeight) ||
		naturalWidth <= 0 ||
		naturalHeight <= 0
	) {
		return { ...fallback };
	}
	const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
	return {
		width: Math.max(24, naturalWidth * scale),
		height: Math.max(24, naturalHeight * scale),
	};
}

function mediaSnapshot(
	path: string,
	snapshot?: BoardMediaSnapshot,
): BoardMediaSnapshot {
	return {
		title: snapshot?.title ?? getResourceTitle(path),
		mimeType: snapshot?.mimeType,
		size: snapshot?.size,
		mtimeMs: snapshot?.mtimeMs,
		naturalWidth: snapshot?.naturalWidth,
		naturalHeight: snapshot?.naturalHeight,
	};
}

export function createImageBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardMediaSnapshot,
): BoardImageItem {
	const size = mediaFrameSize(snapshot?.naturalWidth, snapshot?.naturalHeight);
	return {
		id: createBoardItemId(),
		type: "image",
		ref: { kind: "space-file", path },
		snapshot: mediaSnapshot(path, snapshot),
		frame: createFrame(x - size.width / 2, y - size.height / 2, size),
	};
}

export function createVideoBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardMediaSnapshot,
): BoardVideoItem {
	const size = mediaFrameSize(
		snapshot?.naturalWidth,
		snapshot?.naturalHeight,
		480,
		DEFAULT_VIDEO_SIZE,
	);
	return {
		id: createBoardItemId(),
		type: "video",
		ref: { kind: "space-file", path },
		snapshot: mediaSnapshot(path, {
			...snapshot,
			mimeType: snapshot?.mimeType ?? "video/*",
		}),
		frame: createFrame(x - size.width / 2, y - size.height / 2, size),
	};
}

export function createAudioBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardAudioItem["snapshot"],
): BoardAudioItem {
	return {
		id: createBoardItemId(),
		type: "audio",
		ref: { kind: "space-file", path },
		snapshot: {
			...mediaSnapshot(path, {
				...snapshot,
				mimeType: snapshot?.mimeType ?? "audio/*",
			}),
			...(snapshot?.durationMs === undefined
				? {}
				: { durationMs: snapshot.durationMs }),
		},
		frame: createFrame(
			x - DEFAULT_AUDIO_SIZE.width / 2,
			y - DEFAULT_AUDIO_SIZE.height / 2,
			DEFAULT_AUDIO_SIZE,
		),
	};
}

/**
 * Card sizes for a file node. Both are free-form (the shape has no aspect lock)
 * and deliberately small: a file card is an entry point, not a document view.
 */
const DEFAULT_FILE_SIZE = { width: 260, height: 132 };
const DEFAULT_FILE_COVER_SIZE = { width: 260, height: 208 };

/**
 * Create a file card for any workspace file.
 *
 * The size depends on whether a cover will be drawn, so a card created with a
 * snapshot already in hand lands at its final geometry and never resizes under
 * the user. A snapshot is optional: without one this still yields a usable card
 * that can be enriched later.
 */
export function createFileBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardFileSnapshot,
): BoardFileItem {
	const size =
		filePreviewKind(snapshot) === "cover"
			? DEFAULT_FILE_COVER_SIZE
			: DEFAULT_FILE_SIZE;
	return {
		id: createBoardItemId(),
		type: "file",
		ref: { kind: "space-file", path },
		snapshot: {
			...snapshot,
			title: snapshot?.title ?? fileBaseName(path),
		},
		frame: createFrame(x - size.width / 2, y - size.height / 2, size),
	};
}

/**
 * Create a node for a dropped space file.
 *
 * Every file is accepted. Images and videos get their dedicated media shapes;
 * everything else — text, binaries, unknown extensions — becomes a file card, so
 * dropping onto a board is never refused and simply varies in how much detail it
 * can show.
 */
export function createFileNodeForPath(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardMediaSnapshot & BoardFileSnapshot,
): BoardImageItem | BoardVideoItem | BoardAudioItem | BoardFileItem {
	const kind = inferMediaKind(path, snapshot?.mimeType);
	if (kind === "image") return createImageBoardItem(path, x, y, snapshot);
	if (kind === "video") return createVideoBoardItem(path, x, y, snapshot);
	if (kind === "audio") return createAudioBoardItem(path, x, y, snapshot);
	return createFileBoardItem(path, x, y, snapshot);
}

/**
 * Create an image, video or audio node from a space file path. Non-media files return
 * null.
 *
 * Prefer `createFileNodeForPath`, which never returns null; this narrower helper
 * remains for callers that specifically want media or nothing.
 */
export function createMediaBoardItem(
	path: string,
	x: number,
	y: number,
	snapshot?: BoardMediaSnapshot,
): BoardImageItem | BoardVideoItem | BoardAudioItem | null {
	const kind = inferMediaKind(path, snapshot?.mimeType);
	if (kind === "image") return createImageBoardItem(path, x, y, snapshot);
	if (kind === "video") return createVideoBoardItem(path, x, y, snapshot);
	if (kind === "audio") return createAudioBoardItem(path, x, y, snapshot);
	return null;
}

export function createTaskBoardItem(
	taskRunId: string,
	snapshot: BoardTaskSnapshot,
	x: number,
	y: number,
	metadata?: Record<string, unknown>,
): BoardTaskItem {
	const artifact = featuredTaskArtifact(snapshot.artifacts);
	const visualMedia =
		artifact?.type === "image" || artifact?.type === "video" ? artifact : null;
	const size = visualMedia
		? mediaFrameSize(
				visualMedia.naturalWidth,
				visualMedia.naturalHeight,
				480,
				DEFAULT_TASK_MEDIA_SIZE,
			)
		: artifact?.type === "audio"
			? DEFAULT_TASK_MEDIA_SIZE
			: DEFAULT_TASK_SIZE;
	return {
		id: createBoardItemId(),
		type: "task",
		taskRunId,
		snapshot,
		...(metadata ? { metadata } : {}),
		frame: createFrame(x - size.width / 2, y - size.height / 2, size),
	};
}

export function createTextBoardItem(
	text: string,
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.text.color,
	fontSize: number = TEXT_FONT_SIZE,
): BoardItem {
	// Anchor at the caret point (top-left of the first line).
	return {
		id: createBoardItemId(),
		type: "text",
		text,
		color,
		fontSize,
		frame: createFrame(x, y, measureBoardText(text, fontSize)),
	};
}

const DEFAULT_GEO_SIZE = { width: 200, height: 140 };

export function createGeoBoardItem(
	geo: string,
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.geo.color,
	id = createBoardItemId(),
): BoardItem {
	return {
		id,
		type: "geo",
		geo,
		text: "",
		color,
		fillOpacity: 0,
		frame: createFrame(
			x - DEFAULT_GEO_SIZE.width / 2,
			y - DEFAULT_GEO_SIZE.height / 2,
			DEFAULT_GEO_SIZE,
		),
	};
}

/**
 * Create a freehand draw item from raw world-space samples. The frame is the
 * stroke's padded bounds; points are stored relative to the frame origin so a
 * translate moves the whole stroke by patching the frame alone.
 */
export function createDrawBoardItem(
	worldPoints: Array<{ x: number; y: number; p: number }>,
	color: string,
	size: number,
	id = createBoardItemId(),
): BoardItem {
	const bounds = computeDrawBounds(worldPoints, size);
	const points = worldPoints.map((point) => ({
		x: point.x - bounds.x,
		y: point.y - bounds.y,
		p: point.p,
	}));
	return {
		id,
		type: "draw",
		points,
		color,
		size,
		frame: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			rotation: 0,
		},
	};
}

/**
 * Create a free arrow between two world points.
 *
 * An arrow is an annotation stroke, not a relation: to relate two nodes, create a
 * connection instead (see the editor's `connectNodes`).
 */
export function createArrowBoardItem(
	start: { x: number; y: number },
	end: { x: number; y: number },
	color: string,
	id = createBoardItemId(),
	size: number = DEFAULT_BOARD_TOOL_STYLES.arrow.size,
): BoardItem {
	const item = {
		id,
		type: "arrow" as const,
		start: { x: start.x, y: start.y },
		end: { x: end.x, y: end.y },
		bend: 0,
		color,
		size,
		arrowStart: false,
		arrowEnd: true,
		label: "",
		frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
	};
	return { ...item, frame: arrowFrame(item) };
}

const DEFAULT_FRAME_SIZE = { width: 480, height: 320 };

export type BoardAppMetadata = {
	appId: string;
	ref: string;
	url: string;
	name: string;
	icon?: string;
};

export function createAppBoardItem(
	app: BoardAppMetadata,
	x: number,
	y: number,
	id = createBoardItemId(),
): BoardItem {
	return {
		...createFrameBoardItem(x, y, "brand", app.name, id),
		metadata: { cohubApp: app },
	};
}

export function createFrameBoardItem(
	x: number,
	y: number,
	color: string = DEFAULT_BOARD_TOOL_STYLES.frame.color,
	label = "Frame",
	id = createBoardItemId(),
): BoardItem {
	return {
		id,
		type: "frame",
		label,
		color,
		frame: createFrame(
			x - DEFAULT_FRAME_SIZE.width / 2,
			y - DEFAULT_FRAME_SIZE.height / 2,
			DEFAULT_FRAME_SIZE,
		),
	};
}

/**
 * Create a copy of an item with a fresh id. Pass `offset` (defaults to
 * DUPLICATE_OFFSET) to displace the copy; pass 0 for an in-place clone used by
 * Alt-drag (the subsequent drag provides the visual offset).
 */
export function duplicateBoardItem(
	item: BoardItem,
	offset = DUPLICATE_OFFSET,
): BoardItem {
	const frame: BoardFrame = {
		...item.frame,
		x: item.frame.x + offset,
		y: item.frame.y + offset,
	};
	// An arrow's geometry lives in its endpoints, so those move with the copy; the
	// editor recomputes an exact frame afterwards.
	if (item.type === "arrow") {
		return {
			...structuredClone(item),
			id: createBoardItemId(),
			locked: false,
			start: { x: item.start.x + offset, y: item.start.y + offset },
			end: { x: item.end.x + offset, y: item.end.y + offset },
			frame,
		};
	}
	return {
		...structuredClone(item),
		id: createBoardItemId(),
		locked: false,
		frame,
	};
}

export function patchItemFrame(
	items: BoardItem[],
	id: string,
	frame: BoardFrame,
) {
	return items.map((item) => (item.id === id ? { ...item, frame } : item));
}

/** Apply a frame patch to many items at once, keyed by id. */
export function patchItemFrames(
	items: BoardItem[],
	frames: Map<string, BoardFrame>,
) {
	if (frames.size === 0) return items;
	return items.map((item) => {
		const frame = frames.get(item.id);
		return frame ? { ...item, frame } : item;
	});
}

export function removeBoardItem(items: BoardItem[], id: string) {
	return items.filter((item) => item.id !== id);
}

export function removeBoardItems(items: BoardItem[], ids: Set<string>) {
	if (ids.size === 0) return items;
	return items.filter((item) => !ids.has(item.id));
}

// ─── Labels ─────────────────────────────────────────────────────────

export function titleForBoardItem(item: BoardItem): string {
	switch (item.type) {
		case "text":
			return item.text.split("\n")[0] || "Text";
		case "geo":
			return item.text.split("\n")[0] || item.geo;
		case "draw":
			return "Drawing";
		case "arrow":
			return item.label || "Arrow";
		case "frame":
			return item.label || "Frame";
		case "image":
		case "video":
		case "audio":
			return item.snapshot?.title ?? getResourceTitle(item.ref.path);
		case "file":
			return item.snapshot?.title ?? fileBaseName(item.ref.path);
		case "task":
			return item.snapshot.title;
		default:
			return unknownRealType(item);
	}
}

export function subtitleForBoardItem(item: BoardItem): string {
	switch (item.type) {
		case "text":
			return "Text";
		case "geo":
			return item.geo;
		case "draw":
			return "Drawing";
		case "arrow":
			return "Arrow";
		case "frame":
			return "Frame";
		case "image":
			return "Image";
		case "video":
			return "Video";
		case "audio":
			return "Audio";
		case "file":
			return "File";
		case "task":
			return "Task";
		default:
			return unknownRealType(item);
	}
}
