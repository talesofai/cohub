import { Container, Graphics, Mesh, MeshGeometry, Texture } from "pixi.js";
import type { BoardDrawItem } from "@cohub/protocol/board-document";
import {
	buildStrokeRibbonGeometry,
	computeDrawBounds,
} from "../../core/draw-geometry.js";
import { pickBoardColor } from "../../core/palette.js";
import { positionShell } from "./base-card-renderer.js";
import type {
	BoardCardRenderer,
	BoardRenderContext,
} from "./board-renderer-registry.js";
import { drawFarStroke } from "./far-plate.js";

type DrawParts = {
	root: Container;
	stroke: Graphics | Mesh;
	sig: string;
	/** Last points array rendered; a new array (edit/undo) forces a redraw. */
	points: unknown;
	/** Local-space width the current tessellation was built at. */
	baseWidth: number;
};

const partsByContainer = new WeakMap<Container, DrawParts>();

/** Canvas fallback for environments where Pixi intentionally has no Mesh pipe. */
function createCanvasStroke(
	positions: Float32Array,
	indices: Uint32Array,
	color: number,
	alpha: number,
): Graphics {
	const graphics = new Graphics();
	for (let offset = 0; offset < indices.length; offset += 3) {
		const a = (indices[offset] ?? 0) * 2;
		const b = (indices[offset + 1] ?? 0) * 2;
		const c = (indices[offset + 2] ?? 0) * 2;
		graphics
			.moveTo(positions[a] ?? 0, positions[a + 1] ?? 0)
			.lineTo(positions[b] ?? 0, positions[b + 1] ?? 0)
			.lineTo(positions[c] ?? 0, positions[c + 1] ?? 0)
			.closePath();
	}
	return graphics.fill({ color, alpha });
}

function sync(
	container: Container,
	item: BoardDrawItem,
	context: BoardRenderContext,
) {
	const parts = partsByContainer.get(container);
	if (!parts) return;
	positionShell(parts.root, item);
	const selected = context.selectedIds.has(item.id);
	const hovered = context.hoveredId === item.id;
	const color = pickBoardColor(context.colors, item.color, context.colorScheme);

	// Rebuild the ribbon only when the stroke or its styling changes. Position is
	// handled by positionShell, so a pure drag does not re-tessellate the path.
	// The points array identity is part of the key so an edit/undo that replaces
	// the samples (even at unchanged length) re-renders.
	const sig = [
		item.points.length,
		item.size,
		item.color,
		selected,
		hovered,
		context.colorScheme,
		color.stroke,
	].join("|");
	if (sig !== parts.sig || item.points !== parts.points) {
		parts.sig = sig;
		parts.points = item.points;
		parts.baseWidth = computeDrawBounds(item.points, item.size).width;

		const ribbon = buildStrokeRibbonGeometry(item.points, item.size);
		const alpha = selected || hovered ? 1 : 0.92;
		const nextStroke = context.rendererType !== "canvas"
			? new Mesh({
					geometry: new MeshGeometry({
						positions: ribbon.positions,
						indices: ribbon.indices,
					}),
					texture: Texture.WHITE,
				})
			: createCanvasStroke(ribbon.positions, ribbon.indices, color.stroke, alpha);
		if (nextStroke instanceof Mesh) {
			nextStroke.tint = color.stroke;
			nextStroke.alpha = alpha;
		}
		const previous = parts.stroke;
		parts.stroke = nextStroke;
		parts.root.removeChild(previous);
		previous.destroy();
		parts.root.addChild(nextStroke);
	}

	// A live resize only grows the frame; scale the existing tessellation instead
	// of rebuilding the ribbon on every pointer move. The points are baked at the
	// final scale on pointer-up, which resets this back to 1.
	const previewScale = item.frame.width / Math.max(0.0001, parts.baseWidth);
	parts.stroke.scale.set(Number.isFinite(previewScale) ? previewScale : 1);
}

export const drawCardRenderer: BoardCardRenderer = {
	id: "draw-card",
	canRender: (item) => item.type === "draw",
	create: (item, context) => {
		const root = new Container();
		const stroke = new Graphics();
		root.addChild(stroke);
		partsByContainer.set(root, {
			root,
			stroke,
			sig: "",
			points: null,
			baseWidth: 0,
		});
		if (item.type === "draw") sync(root, item, context);
		return root;
	},
	update: (container, item, context) => {
		if (item.type === "draw") sync(container, item, context);
	},
	// Far LOD: the stroke's path is its content, so it is drawn as a decimated
	// polyline rather than a plate. Batching it also keeps it in document order —
	// as a live container it would sit above every plate on the board.
	renderFar: (graphics, item, context) => {
		if (item.type !== "draw") return;
		const color = pickBoardColor(context.colors, item.color, context.colorScheme);
		drawFarStroke(graphics, item.points, {
			color: color.stroke,
			width: item.size,
			alpha: 0.92,
		});
	},
	destroy: (container) => {
		partsByContainer.get(container)?.root.destroy({ children: true });
		partsByContainer.delete(container);
	},
};
