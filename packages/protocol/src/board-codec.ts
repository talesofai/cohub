import {
	BoardAuthoringItemSchema,
	BoardItemPatchSchema,
	type BoardAuthoringItem,
} from "./board-authoring.js";
import {
	BoardNodeInputSchema,
	type BoardNodeInput,
	type BoardNodeRecord,
} from "./board.js";
import {
	BOARD_NATIVE_NODE_TYPES,
	validateBoardNodeInput,
	type BoardNodeValidationDiagnostic,
} from "./board-node.js";
import {
	boardArrowFrame,
	boardDrawBounds,
	boardDrawPointsToLocal,
	boardDrawPointsToWorld,
} from "./board-geometry.js";

export class BoardItemValidationError extends Error {
	diagnostics: BoardNodeValidationDiagnostic[];

	constructor(diagnostics: BoardNodeValidationDiagnostic[]) {
		super(diagnostics[0]?.message ?? "invalid Board item");
		this.diagnostics = diagnostics;
		this.name = "BoardItemValidationError";
	}
}

export function authoringSchemaDiagnostics(
	error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] },
	path: string,
): BoardNodeValidationDiagnostic[] {
	return error.issues.slice(0, 32).map((issue) => ({
		severity: "error" as const,
		code: "INVALID_BOARD_NODE" as const,
		message: issue.message,
		path: `${path}.${issue.path.map(String).join(".") || "item"}`,
	}));
}

function authoringDiagnostic(
	diagnostic: BoardNodeValidationDiagnostic,
	path: string,
): BoardNodeValidationDiagnostic {
	const internalPath = diagnostic.path;
	const suffix = internalPath.replace(/^node(?:\.|$)/, "");
	const authoringSuffix = suffix
		.replace(/^data\.points/, "props.points")
		.replace(/^data\./, "props.")
		.replace(/^style\./, "style.")
		.replace(/^view\./, "source.snapshot.")
		.replace(/^nodeId$/, "id")
		.replace(/^(x|y)$/, "position.$1")
		.replace(/^(width|height)$/, "size.$1");
	const mappedPath = `${path}${authoringSuffix ? `.${authoringSuffix}` : ""}`;
	return { ...diagnostic, path: mappedPath, message: diagnostic.message.replace(internalPath, mappedPath) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

function baseItem(node: BoardNodeInput) {
	return {
		id: node.nodeId,
		position: { x: node.x, y: node.y },
		size: { width: node.width, height: node.height },
		rotation: node.rotation,
		...(node.parentId ? { parentId: node.parentId } : {}),
		...(node.data.locked === true ? { locked: true } : {}),
		...(isRecord(node.data.metadata) ? { metadata: node.data.metadata } : {}),
	};
}

function filePath(node: BoardNodeInput): string {
	if (!node.refPath) throw new Error(`Board item ${node.nodeId} is missing its source path`);
	return node.refPath;
}

function style(node: BoardNodeInput) {
	const value: Record<string, unknown> = {};
	if (typeof node.data.color === "string") value.color = node.data.color;
	if (typeof node.data.size === "number") value.strokeWidth = node.data.size;
	if (typeof node.data.fillOpacity === "number") value.fillOpacity = node.data.fillOpacity;
	return Object.keys(value).length ? value : undefined;
}

export function boardNodeToAuthoringItem(node: BoardNodeInput | BoardNodeRecord): BoardAuthoringItem {
	const base = baseItem(node);
	if (node.type === "draw" || node.type === "arrow") {
		delete (base as { size?: unknown }).size;
		delete (base as { position?: unknown }).position;
	}
	const visual = style(node);
	let candidate: Record<string, unknown>;
	switch (node.type) {
		case "text": candidate = { ...base, type: "text", props: { text: node.data.text ?? "", fontSize: node.data.fontSize ?? 24 }, ...(visual ? { style: visual } : {}) }; break;
		case "geo": candidate = { ...base, type: "geo", props: { shape: node.data.geo ?? "rectangle", text: node.data.text ?? "" }, ...(visual ? { style: visual } : {}) }; break;
		case "draw": candidate = { ...base, type: "draw", props: { points: Array.isArray(node.data.points) ? boardDrawPointsToWorld(node.data.points as Array<{ x: number; y: number; p: number }>, node.x, node.y) : [] }, ...(visual ? { style: visual } : {}) }; break;
		case "arrow": candidate = { ...base, type: "arrow", props: { start: node.data.start, end: node.data.end, bend: node.data.bend ?? 0, arrowStart: node.data.arrowStart ?? false, arrowEnd: node.data.arrowEnd ?? true, label: node.data.label ?? "" }, ...(visual ? { style: visual } : {}) }; break;
		case "frame": candidate = { ...base, type: "frame", props: { label: node.data.label ?? "Frame" }, ...(visual ? { style: visual } : {}) }; break;
		case "image": candidate = { ...base, type: "image", props: isRecord(node.data.crop) ? { crop: node.data.crop } : {}, source: { kind: "space-file", path: filePath(node), ...(Object.keys(node.view).length ? { snapshot: node.view } : {}) } }; break;
		case "video":
		case "audio":
		case "file": candidate = { ...base, type: node.type, props: {}, source: { kind: "space-file", path: filePath(node), ...(Object.keys(node.view).length ? { snapshot: node.view } : {}) } }; break;
		case "task": candidate = { ...base, type: "task", props: { taskRunId: node.data.taskRunId, snapshot: node.view } }; break;
		default: {
			const props = { ...node.data };
			delete props.locked;
			delete props.metadata;
			delete props.kindVersion;
			candidate = { ...base, type: node.type, kindVersion: typeof node.data.kindVersion === "number" ? node.data.kindVersion : 1, props, ...(Object.keys(node.style).length ? { style: node.style } : {}), ...(node.refPath ? { source: { kind: node.refKind ?? "space-file", ref: node.refPath, ...(Object.keys(node.view).length ? { snapshot: node.view } : {}) } } : {}) };
		}
	}
	return BoardAuthoringItemSchema.parse(candidate);
}

function commonData(item: BoardAuthoringItem) {
	return { ...(item.locked ? { locked: true } : {}), ...(item.metadata ? { metadata: item.metadata } : {}) };
}

function defaultSize(type: BoardAuthoringItem["type"]) {
	if (type === "frame") return { width: 480, height: 320 };
	if (type === "text") return { width: 320, height: 48 };
	if (type === "task") return { width: 420, height: 240 };
	if (type === "image" || type === "video") return { width: 640, height: 360 };
	if (type === "audio") return { width: 480, height: 96 };
	if (type === "file") return { width: 360, height: 220 };
	return { width: 240, height: 160 };
}

function authoringFrame(item: BoardAuthoringItem) {
	if (item.type === "draw") {
		const points = item.props as { points: Array<{ x: number; y: number; p: number }> };
		const size = Number((item.style as { strokeWidth?: unknown } | undefined)?.strokeWidth ?? 4);
		const bounds = boardDrawBounds(points.points, size);
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: item.rotation };
	}
	if (item.type === "arrow") {
		const props = item.props as { start: { x: number; y: number }; end: { x: number; y: number }; bend: number };
		return { ...boardArrowFrame({ ...props, size: Number((item.style as { strokeWidth?: unknown } | undefined)?.strokeWidth ?? 2.5) }), rotation: item.rotation };
	}
	const position = (item as { position: { x: number; y: number } }).position;
	const size = (item as { size?: { width: number; height: number } }).size ?? defaultSize(item.type);
	return { x: position.x, y: position.y, width: size.width, height: size.height, rotation: item.rotation };
}

export function boardAuthoringItemToNode(value: unknown, options: { orderKey?: string | null; path?: string } = {}): BoardNodeInput {
	const item = BoardAuthoringItemSchema.parse(value);
	const node: BoardNodeInput = {
		nodeId: item.id,
		type: item.type,
		parentId: item.parentId ?? null,
		orderKey: options.orderKey ?? null,
		...authoringFrame(item),
		refKind: null,
		refPath: null,
		refUrl: null,
		view: {},
		style: {},
		data: commonData(item),
	};
	const itemStyle = "style" in item ? item.style : undefined;
	const color = itemStyle && "color" in itemStyle ? itemStyle.color : undefined;
	const strokeWidth = itemStyle && "strokeWidth" in itemStyle ? itemStyle.strokeWidth : undefined;
	const fillOpacity = itemStyle && "fillOpacity" in itemStyle ? itemStyle.fillOpacity : undefined;
	switch (item.type) {
		case "text": node.data = { ...node.data, ...item.props, color: color ?? "neutral" }; break;
		case "geo": node.data = { ...node.data, geo: item.props.shape, text: item.props.text, color: color ?? "brand", fillOpacity: fillOpacity ?? 0 }; break;
		case "draw": {
			const points = item.props as { points: Array<{ x: number; y: number; p: number }> };
			node.data = { ...node.data, points: boardDrawPointsToLocal(points.points, node.x, node.y), color: color ?? "brand", size: strokeWidth ?? 4 };
			break;
		}
		case "arrow": node.data = { ...node.data, ...item.props, color: color ?? "brand", size: strokeWidth ?? 2.5 }; break;
		case "frame": node.data = { ...node.data, ...item.props, color: color ?? "neutral" }; break;
		case "image": {
			const source = item.source as { kind: "space-file"; path: string; snapshot?: Record<string, unknown> };
			node.data = { ...node.data, ...(item.props.crop ? { crop: item.props.crop } : {}) };
			node.refKind = "space_file";
			node.refPath = source.path;
			node.view = source.snapshot ?? {};
			break;
		}
		case "video":
		case "audio":
		case "file": {
			const source = item.source as { kind: "space-file"; path: string; snapshot?: Record<string, unknown> };
			node.refKind = "space_file";
			node.refPath = source.path;
			node.view = source.snapshot ?? {};
			break;
		}
		case "task": node.data = { ...node.data, taskRunId: item.props.taskRunId }; node.view = item.props.snapshot as Record<string, unknown>; break;
		default: { const extension = item as Extract<BoardAuthoringItem, { kindVersion: number }>; node.data = { ...node.data, ...extension.props, kindVersion: extension.kindVersion }; node.style = extension.style ?? {}; if (extension.source) { node.refKind = extension.source.kind; node.refPath = extension.source.ref; node.view = extension.source.snapshot ?? {}; } }
	}
	if ((BOARD_NATIVE_NODE_TYPES as readonly string[]).includes(node.type)) {
		const diagnostics = validateBoardNodeInput(node);
		if (diagnostics.length) {
			throw new BoardItemValidationError(diagnostics.map((diagnostic) =>
				authoringDiagnostic(diagnostic, options.path ?? "item"),
			));
		}
	} else {
		const parsed = BoardNodeInputSchema.safeParse(node);
		if (!parsed.success) {
			throw new BoardItemValidationError(parsed.error.issues.map((issue) => ({
				severity: "error" as const,
				code: "INVALID_BOARD_NODE" as const,
				message: issue.message,
				path: `${options.path ?? "item"}.${issue.path.join(".") || "item"}`,
			})));
		}
	}
	return node;
}

export function applyBoardItemPatch(current: BoardAuthoringItem, value: unknown, path = "item"): BoardAuthoringItem {
	const patch = BoardItemPatchSchema.parse(value);
	const merged = mergePatch(current, patch) as Record<string, unknown>;
	merged.id = current.id;
	merged.type = current.type;
	if ("kindVersion" in current) merged.kindVersion = current.kindVersion;
	const parsed = BoardAuthoringItemSchema.safeParse(merged);
	if (!parsed.success) {
		throw new BoardItemValidationError(authoringSchemaDiagnostics(parsed.error, path));
	}
	return parsed.data;
}

function mergePatch(current: unknown, patch: unknown): unknown {
	if (!isRecord(patch)) return patch;
	const result: Record<string, unknown> = isRecord(current) ? { ...current } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete result[key];
		else result[key] = isRecord(value) ? mergePatch(result[key], value) : value;
	}
	return result;
}
