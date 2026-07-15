import type {
	CanvasDocumentRecord,
	CanvasNodeInput,
	CanvasNodeRecord,
	CanvasSemanticOp,
} from "@neta-art/cohub";
import {
	CANVAS_DOCUMENT_KIND,
	type CanvasAppearance,
	CanvasAppearanceSchema,
	type CanvasItem,
	type CanvasResourceSnapshot,
	type CovasDocument,
	CovasDocumentSchema,
} from "$lib/canvas/canvas-schema";

export const DEFAULT_CANVAS_APPEARANCE: CanvasAppearance =
	CanvasAppearanceSchema.parse({
		theme: "clean",
		background: { kind: "grid" },
		grid: { visible: true, size: 32, opacity: 0.22 },
		mood: "clean",
	});

export function createEmptyCovasDocument(): CovasDocument {
	return CovasDocumentSchema.parse({
		kind: CANVAS_DOCUMENT_KIND,
		version: 1,
		appearance: DEFAULT_CANVAS_APPEARANCE,
		viewport: { x: 0, y: 0, zoom: 1 },
		items: [],
	});
}

export function parseCovasDocument(
	content: string,
): { ok: true; document: CovasDocument } | { ok: false; error: string } {
	try {
		const raw = JSON.parse(content || "{}");
		const parsed = CovasDocumentSchema.safeParse(raw);
		if (!parsed.success) {
			return {
				ok: false,
				error: parsed.error.issues[0]?.message ?? "Invalid canvas document",
			};
		}
		return { ok: true, document: parsed.data };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Invalid JSON",
		};
	}
}

export function serializeCovasDocument(document: CovasDocument) {
	return `${JSON.stringify(CovasDocumentSchema.parse(document), null, 2)}\n`;
}

export type CovasManifest = {
	kind: "cohub.canvas.manifest";
	version: 1;
	documentId: string;
	title: string;
};

export function parseCovasManifest(content: string): CovasManifest | null {
	try {
		const raw = JSON.parse(content || "{}");
		if (
			raw?.kind === "cohub.canvas.manifest" &&
			raw.version === 1 &&
			typeof raw.documentId === "string" &&
			typeof raw.title === "string"
		)
			return raw as CovasManifest;
		return null;
	} catch {
		return null;
	}
}

export function canvasNodeToItem(node: CanvasNodeRecord): CanvasItem {
	const frame = {
		x: node.x,
		y: node.y,
		width: node.width,
		height: node.height,
		rotation: node.rotation,
	};
	const style = Object.keys(node.style ?? {}).length
		? (node.style as CanvasItem["style"])
		: undefined;
	if (node.type === "text") {
		return {
			id: node.nodeId,
			type: "text",
			text: typeof node.data?.text === "string" ? node.data.text : "Text",
			frame,
			style,
		};
	}
	if (node.refKind === "remote_url" && node.refUrl) {
		return {
			id: node.nodeId,
			type: "resource",
			ref: { kind: "remote-url", url: node.refUrl },
			snapshot: node.view as CanvasResourceSnapshot,
			frame,
			style,
		};
	}
	return {
		id: node.nodeId,
		type: "resource",
		ref: { kind: "space-file", path: node.refPath || "missing" },
		snapshot: node.view as CanvasResourceSnapshot,
		frame,
		style,
	};
}

export function canvasItemToNode(
	item: CanvasItem,
	index: number,
): CanvasNodeInput {
	const base = {
		nodeId: item.id,
		type: item.type === "text" ? "text" : "file",
		parentId: null,
		orderKey: String(index).padStart(8, "0"),
		x: item.frame.x,
		y: item.frame.y,
		width: item.frame.width,
		height: item.frame.height,
		rotation: item.frame.rotation,
		view: item.type === "resource" ? (item.snapshot ?? {}) : {},
		style: item.style ?? {},
		animation: {},
		data: item.type === "text" ? { text: item.text } : {},
	};
	if (item.type === "text")
		return { ...base, refKind: null, refPath: null, refUrl: null };
	return item.ref.kind === "space-file"
		? { ...base, refKind: "space_file", refPath: item.ref.path, refUrl: null }
		: {
				...base,
				type: "url",
				refKind: "remote_url",
				refPath: null,
				refUrl: item.ref.url,
			};
}

export function canvasBootstrapToDocument(input: {
	document: CanvasDocumentRecord;
	nodes: CanvasNodeRecord[];
}): CovasDocument {
	return CovasDocumentSchema.parse({
		kind: CANVAS_DOCUMENT_KIND,
		version: 1,
		appearance: DEFAULT_CANVAS_APPEARANCE,
		viewport: { x: 0, y: 0, zoom: 1 },
		items: input.nodes.map(canvasNodeToItem),
	});
}

function nodeInputToItem(node: CanvasNodeInput): CanvasItem {
	return canvasNodeToItem({
		documentId: "",
		version: 0,
		createdAt: null,
		updatedAt: null,
		deletedAt: null,
		...node,
	});
}

const sameJson = (a: unknown, b: unknown) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function nodePatch(before: CanvasNodeInput, after: CanvasNodeInput) {
	const patch: Record<string, unknown> = {};
	const inverse: Record<string, unknown> = {};
	const keys = [
		"type",
		"parentId",
		"orderKey",
		"x",
		"y",
		"width",
		"height",
		"rotation",
		"refKind",
		"refPath",
		"refUrl",
		"view",
		"style",
		"animation",
		"data",
	] as const;
	for (const key of keys) {
		if (!sameJson(before[key], after[key])) {
			patch[key] = after[key] ?? null;
			inverse[key] = before[key] ?? null;
		}
	}
	return Object.keys(patch).length ? { patch, inverse } : null;
}

export function diffCanvasDocuments(
	before: CovasDocument,
	after: CovasDocument,
): CanvasSemanticOp[] {
	const beforeNodes = new Map(
		before.items.map((item, index) => [item.id, canvasItemToNode(item, index)]),
	);
	const afterNodes = new Map(
		after.items.map((item, index) => [item.id, canvasItemToNode(item, index)]),
	);
	const ops: CanvasSemanticOp[] = [];
	for (const [nodeId, node] of afterNodes) {
		const previous = beforeNodes.get(nodeId);
		if (!previous) {
			ops.push({ type: "node.create", payload: { node }, inverse: { nodeId } });
			continue;
		}
		const diff = nodePatch(previous, node);
		if (diff)
			ops.push({
				type: "node.patch",
				payload: { nodeId, patch: diff.patch },
				inverse: diff.inverse,
			});
	}
	for (const [nodeId, node] of beforeNodes) {
		if (!afterNodes.has(nodeId))
			ops.push({ type: "node.delete", payload: { nodeId }, inverse: { node } });
	}
	return ops;
}

export function invertCanvasOps(ops: CanvasSemanticOp[]): CanvasSemanticOp[] {
	return [...ops].reverse().map((op) => {
		if (op.type === "node.create") {
			const node = op.payload.node as CanvasNodeInput | undefined;
			return {
				type: "node.delete",
				payload: { nodeId: node?.nodeId },
				inverse: op.payload,
			};
		}
		if (op.type === "node.delete") {
			return {
				type: "node.create",
				payload: { node: op.inverse?.node },
				inverse: op.payload,
			};
		}
		if (op.type === "node.data.merge") {
			return {
				version: 2,
				type: "node.data.merge",
				payload: { nodeId: op.payload.nodeId, data: op.inverse ?? {} },
				inverse: op.payload.data as Record<string, unknown>,
			};
		}
		if (op.type === "document.meta.patch") {
			return {
				version: 2,
				type: "document.meta.patch",
				payload: { patch: op.inverse ?? {} },
				inverse: op.payload.patch as Record<string, unknown>,
			};
		}
		return {
			type: "node.patch",
			payload: { nodeId: op.payload.nodeId, patch: op.inverse ?? {} },
			inverse: op.payload.patch as Record<string, unknown>,
		};
	});
}

export function applyCanvasOps(
	document: CovasDocument,
	ops: CanvasSemanticOp[],
): CovasDocument {
	let items = [...document.items];
	for (const op of ops) {
		if (op.type === "node.create") {
			const node = op.payload.node as CanvasNodeInput | undefined;
			if (node && !items.some((item) => item.id === node.nodeId))
				items = [...items, nodeInputToItem(node)];
			continue;
		}
		if (op.type === "node.delete") {
			const nodeId = op.payload.nodeId;
			if (typeof nodeId === "string")
				items = items.filter((item) => item.id !== nodeId);
			continue;
		}
		if (op.type === "document.meta.patch") continue;
		const nodeId = op.payload.nodeId;
		const patch =
			op.type === "node.data.merge"
				? { data: op.payload.data as Record<string, unknown> }
				: (op.payload.patch as Partial<CanvasNodeInput> | undefined);
		if (typeof nodeId !== "string" || !patch) continue;
		items = items.map((item, index) => {
			if (item.id !== nodeId) return item;
			const current = canvasItemToNode(item, index);
			return nodeInputToItem({
				...current,
				...patch,
				data:
					op.type === "node.data.merge"
						? { ...current.data, ...(patch.data ?? {}) }
						: (patch.data ?? current.data),
				nodeId,
			});
		});
	}
	return { ...document, items };
}
