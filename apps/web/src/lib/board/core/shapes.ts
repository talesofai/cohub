/**
 * Concrete shape definitions + registration.
 *
 * Importing this module for its side effect registers every native shape with
 * the shape-definition registry. Box shapes (text, image, video, geo) share
 * frame-based geometry; geo refines hit testing per outline; draw and arrow
 * define their own geometry, handles and capabilities.
 */

import type {
	BoardArrowItem,
	BoardDrawItem,
	BoardGeoItem,
} from "@neta-art/cohub/board";
import {
	arrowBounds,
	computeDrawBounds,
	degToRad,
	distanceToArrow,
	distanceToStroke,
	FULL_CAPABILITIES,
	frameContainsPoint,
	rectCenter,
	registerShapeDefinition,
	resolveArrow,
	rotatePointAround,
	type ShapeDefinition,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";

/** Transform a world point into a draw item's local (unrotated) space. */
function drawLocalPoint(item: BoardDrawItem, point: WorldPoint): WorldPoint {
	const center = rectCenter(item.frame);
	const rotated = item.frame.rotation
		? rotatePointAround(point, center, -degToRad(item.frame.rotation))
		: point;
	return worldPoint(rotated.x - item.frame.x, rotated.y - item.frame.y);
}

const textDefinition: ShapeDefinition = {
	type: "text",
	// Resize scales the font size, so width and height move together.
	capabilities: { ...FULL_CAPABILITIES, canEdit: true, aspectLocked: true },
};

const imageDefinition: ShapeDefinition = {
	type: "image",
	// The frame tracks the image's pixel aspect, so it can never letterbox.
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: true,
		aspectLocked: true,
	},
};

const videoDefinition: ShapeDefinition = {
	type: "video",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
		aspectLocked: true,
	},
};

const audioDefinition: ShapeDefinition = {
	type: "audio",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
	},
};

/**
 * File card — the universal fallback for any workspace file.
 *
 * Its content is chrome and text at a fixed internal layout rather than a single
 * intrinsically-scaled image, so the frame is free-form (no aspect lock) and
 * rotation stays off to keep labels legible. `canEdit` is false because
 * activating a file card opens the file in the workspace preview — the same
 * destination as clicking it in the file tree — instead of entering an inline
 * canvas editor.
 */
const fileDefinition: ShapeDefinition = {
	type: "file",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
	},
};

const taskDefinition: ShapeDefinition = {
	type: "task",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: false,
		canRotate: false,
		// Media-led task nodes keep their preview aspect like image and video nodes.
		aspectLocked: true,
	},
};

/** Precise containment for a geo shape in its local (unrotated) space. */
function geoContainsLocal(item: BoardGeoItem, local: WorldPoint): boolean {
	const w = item.frame.width;
	const h = item.frame.height;
	const nx = (local.x / w) * 2 - 1; // -1..1
	const ny = (local.y / h) * 2 - 1;
	switch (item.geo) {
		case "ellipse":
			return nx * nx + ny * ny <= 1;
		case "diamond":
			return Math.abs(nx) + Math.abs(ny) <= 1;
		case "triangle": {
			// Apex at top-center, base along the bottom.
			return ny >= -1 && ny <= 1 && Math.abs(nx) <= (ny + 1) / 2;
		}
		default:
			return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
	}
}

const geoDefinition: ShapeDefinition = {
	type: "geo",
	capabilities: { ...FULL_CAPABILITIES, canEdit: true },
	hitTest: (item, point) => {
		if (item.type !== "geo") return false;
		if (!frameContainsPoint(item.frame, point)) return false;
		const center = rectCenter(item.frame);
		const rotated = item.frame.rotation
			? rotatePointAround(point, center, -degToRad(item.frame.rotation))
			: point;
		return geoContainsLocal(
			item,
			worldPoint(rotated.x - item.frame.x, rotated.y - item.frame.y),
		);
	},
};

const drawDefinition: ShapeDefinition = {
	type: "draw",
	// Resizing scales the stroke geometry (points + width) uniformly.
	capabilities: {
		...FULL_CAPABILITIES,
		canResize: true,
		aspectLocked: true,
		canEdit: false,
		canConnect: false,
		canRotate: false,
	},
	getBounds: (item) =>
		item.type === "draw"
			? translateRect(
					computeDrawBounds(item.points, item.size),
					item.frame.x,
					item.frame.y,
				)
			: { x: 0, y: 0, width: 1, height: 1 },
	hitTest: (item, point) => {
		if (item.type !== "draw") return false;
		const local = drawLocalPoint(item, point);
		const threshold = Math.max(6, item.size);
		return distanceToStroke(item.points, local) <= threshold;
	},
};

function translateRect(
	rect: { x: number; y: number; width: number; height: number },
	dx: number,
	dy: number,
) {
	return {
		x: rect.x + dx,
		y: rect.y + dy,
		width: rect.width,
		height: rect.height,
	};
}

/**
 * Arrow definition. Bounds and hit testing resolve endpoints against the live
 * item set, so the editor passes a frame lookup via the context-bound helpers
 * below (arrowHitTest / arrowBoundsFor). The definition's own hitTest falls back
 * to a coarse frame test when no lookup is available.
 */
const arrowDefinition: ShapeDefinition = {
	type: "arrow",
	capabilities: {
		...FULL_CAPABILITIES,
		canResize: false,
		canRotate: false,
		canEdit: false,
		canConnect: false,
		canSnap: false,
	},
	// Coarse frame fallback; the editor uses the precise arrowHitTest (curve
	// distance) for arrows. Endpoint handles are resolved in world space by the
	// editor (via resolveArrow), not as local box handles.
	hitTest: (item, point) =>
		item.type === "arrow" ? frameContainsPoint(item.frame, point) : false,
	getHandles: () => [
		{ id: "start", x: 0, y: 0 },
		{ id: "end", x: 1, y: 1 },
	],
};

const frameDefinition: ShapeDefinition = {
	type: "frame",
	capabilities: {
		...FULL_CAPABILITIES,
		canEdit: true,
		canRotate: false,
		canConnect: false,
	},
};

/** Precise arrow hit test against its own curve. */
export function arrowHitTest(item: BoardArrowItem, point: WorldPoint): boolean {
	const threshold = Math.max(8, item.size * 2);
	return distanceToArrow(item, point) <= threshold;
}

/** Arrow bounds (used by the editor for culling). */
export function arrowBoundsFor(item: BoardArrowItem) {
	return arrowBounds(item);
}

/** Resolved arrow geometry for rendering and the selection overlay. */
export function resolveArrowFor(item: BoardArrowItem) {
	return resolveArrow(item);
}

let registered = false;

/** Register all native shape definitions. Idempotent. */
export function registerBuiltinShapes() {
	if (registered) return;
	registered = true;
	for (const definition of [
		textDefinition,
		imageDefinition,
		videoDefinition,
		audioDefinition,
		fileDefinition,
		taskDefinition,
		geoDefinition,
		drawDefinition,
		arrowDefinition,
		frameDefinition,
	])
		registerShapeDefinition(definition);
}

// Register on import so any consumer of shape behaviour gets the full set.
registerBuiltinShapes();
