import type { Container, Graphics, Texture } from "pixi.js";
import type { BoardDocument, BoardItem } from "@cohub/protocol/board-document";
import type { BoardShapeColors } from "../../core/palette.js";
import { ensureBoardTextMeasurement } from "../text-measurement.js";
import { arrowCardRenderer } from "./arrow-card-renderer.js";
import { audioCardRenderer } from "./audio-card-renderer.js";
import { drawCardRenderer } from "./draw-card-renderer.js";
import { fileCardRenderer } from "./file-card-renderer.js";
import { frameCardRenderer } from "./frame-card-renderer.js";
import { geoCardRenderer } from "./geo-card-renderer.js";
import { imageCardRenderer } from "./image-card-renderer.js";
import { taskCardRenderer } from "./task-card-renderer.js";
import { textCardRenderer } from "./text-card-renderer.js";
import { unknownCardRenderer } from "./unknown-card-renderer.js";
import { videoCardRenderer } from "./video-card-renderer.js";

export type BoardRenderPalette = {
	bg: number;
	surface: number;
	hover: number;
	border: number;
	brand: number;
	text: number;
	muted: number;
	rare: number;
	epic: number;
	legendary: number;
};

export type BoardRenderContext = {
	document: BoardDocument;
	/**
	 * O(1) item lookup by id. Renderers that need to resolve references (arrow
	 * bindings) must use this rather than scanning `document.items`, which would
	 * be O(items) per card per frame.
	 */
	getItem: (id: string) => BoardItem | null;
	selectedIds: Set<string>;
	hoveredId: string | null;
	/** Nodes currently receiving a live resize preview. */
	resizingIds: Set<string>;
	palette: BoardRenderPalette;
	/**
	 * Live shape colors resolved from CSS tokens (theme + space theme.css).
	 * Prefer this over hard-coded light/dark tables at render time.
	 */
	colors: BoardShapeColors;
	/** Resolved color mode, for fallback mapping when colors are unavailable. */
	colorScheme: "dark" | "light";
	/** Rendering backend selected by the host; Canvas uses compatibility paths. */
	rendererType: "gpu" | "canvas";
	/** Current camera zoom — used for text re-rasterisation buckets. */
	zoom: number;
	/** Stable preview texture key for an item, or null when it has no preview. */
	assetKey: (item: BoardItem) => string | null;
	/** Currently loaded texture for a key (null while loading). */
	getTexture: (key: string) => Texture | null;
	/** Whether the preview for a key failed to load (for a failure placeholder). */
	hasError: (key: string) => boolean;
	/**
	 * Whether a referenced workspace file could not be read, and why. Transient,
	 * client-local state — never part of the document — so one client's outage is
	 * not shown to everyone.
	 */
	fileState: (path: string) => "ok" | "missing" | "unavailable";
	/** Reference-counted texture acquisition and release. */
	acquireTexture: (key: string) => void;
	releaseTexture: (key: string) => void;
};

export type BoardCardRenderer = {
	id: string;
	canRender: (item: BoardItem, context: BoardRenderContext) => boolean;
	create: (item: BoardItem, context: BoardRenderContext) => Container;
	/** Efficiently sync an existing container to a (possibly changed) item. */
	update: (
		container: Container,
		item: BoardItem,
		context: BoardRenderContext,
	) => void;
	/**
	 * Draw the item as flat batched geometry into a shared `Graphics`, for the
	 * far LOD used when too many cards are on screen to afford a container each.
	 *
	 * Implementing this opts the shape into the far layer: past the scene's
	 * visible-card threshold it is drawn here instead of being materialised, so
	 * cost stops scaling with node count. Omit it for shapes whose whole point is
	 * their vector detail (strokes, arrows, frames) — those keep real containers.
	 *
	 * Must draw in world space and must not allocate per call beyond the path
	 * itself; this runs once per far-capable item on every far-layer rebuild.
	 */
	renderFar?: (
		graphics: Graphics,
		item: BoardItem,
		context: BoardRenderContext,
	) => void;
	destroy?: (container: Container, context: BoardRenderContext) => void;
};

const boardCardRenderers: BoardCardRenderer[] = [
	textCardRenderer,
	imageCardRenderer,
	videoCardRenderer,
	audioCardRenderer,
	fileCardRenderer,
	taskCardRenderer,
	geoCardRenderer,
	drawCardRenderer,
	arrowCardRenderer,
	frameCardRenderer,
	unknownCardRenderer,
];

/**
 * Every registered renderer, for invariants that must hold across all of them —
 * notably that each can draw itself at far LOD, which is what keeps the far
 * layer's z-order correct (see board-scene).
 */
export function boardCardRenderersForTest(): readonly BoardCardRenderer[] {
	return boardCardRenderers;
}

export function getBoardCardRenderer(
	item: BoardItem,
	context: BoardRenderContext,
) {
	// Drawing a card measures its text, so the canvas measurer has to be in place
	// by now. Doing it here means no caller can forget, and it costs one boolean
	// check after the first call.
	ensureBoardTextMeasurement();
	return (
		boardCardRenderers.find((renderer) => renderer.canRender(item, context)) ??
		unknownCardRenderer
	);
}

export function registerBoardCardRenderer(renderer: BoardCardRenderer) {
	const existingIndex = boardCardRenderers.findIndex(
		(candidate) => candidate.id === renderer.id,
	);
	if (existingIndex >= 0) boardCardRenderers.splice(existingIndex, 1, renderer);
	else boardCardRenderers.unshift(renderer);
}
