import { z } from "zod";
import {
	BOARD_ARROW_STROKE_SIZE,
	BOARD_DRAW_STROKE_SIZE,
	BOARD_STROKE_MAX_SIZE,
	BOARD_STROKE_MIN_SIZE,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
	type BoardCoordinateSpace,
} from "./board-constants.js";
import { BoardTaskSnapshotSchema } from "./board-document.js";
import { boardArrowFrame, boardDrawBounds } from "./board-geometry.js";

export const BOARD_COLOR_IDS = [
	"brand",
	"neutral",
	"black",
	"white",
	"blue",
	"green",
	"amber",
	"violet",
	"rose",
] as const;
export type BoardColorId = (typeof BOARD_COLOR_IDS)[number];
export const BoardColorIdSchema = z.enum(BOARD_COLOR_IDS);

export const BOARD_GEO_KINDS = [
	"rectangle",
	"rounded",
	"ellipse",
	"diamond",
	"triangle",
] as const;
export type BoardGeoKind = (typeof BOARD_GEO_KINDS)[number];
export const BoardGeoKindSchema = z.enum(BOARD_GEO_KINDS);

export const BOARD_NATIVE_NODE_TYPES = [
	"image",
	"video",
	"audio",
	"file",
	"task",
	"text",
	"geo",
	"draw",
	"arrow",
	"frame",
] as const;
export type BoardNativeNodeType = (typeof BOARD_NATIVE_NODE_TYPES)[number];

export type BoardNodeValidationDiagnostic = {
	severity: "error";
	code: "INVALID_BOARD_NODE" | "INVALID_BOARD_GEOMETRY";
	message: string;
	path: string;
	expected?: string;
	received?: unknown;
	allowedValues?: readonly string[];
	coordinateSpace?: BoardCoordinateSpace;
};

type BoardJsonSchema = Record<string, unknown>;

export type BoardNodeContract = {
	types: readonly BoardNativeNodeType[];
	colors: readonly BoardColorId[];
	geos: readonly BoardGeoKind[];
	coordinates: {
		frame: "world";
		drawPoints: "frame-local";
		arrowEndpoints: "world";
	};
	references: {
		nodeTypes: readonly ["image", "video", "audio", "file"];
		kind: "space_file";
		pathField: "refPath";
	};
	schemas: {
		envelope: BoardJsonSchema;
		data: Record<BoardNativeNodeType, BoardJsonSchema>;
		view: Record<BoardNativeNodeType, BoardJsonSchema>;
	};
};

const metadataSchema = z.record(z.string(), z.unknown());
const commonData = {
	locked: z.boolean().optional(),
	metadata: metadataSchema.optional(),
};
const pointSchema = z
	.object({
		x: z.number().finite(),
		y: z.number().finite(),
		p: z.number().finite().min(0).max(1).default(0.5),
	})
	.strict();
const worldPointSchema = z
	.object({
		x: z.number().finite(),
		y: z.number().finite(),
	})
	.strict();
const strokeSizeSchema = z
	.number()
	.finite()
	.min(BOARD_STROKE_MIN_SIZE)
	.max(BOARD_STROKE_MAX_SIZE);

const mediaViewSchema = z
	.object({
		title: z.string().optional(),
		mimeType: z.string().optional(),
		size: z.number().finite().nonnegative().optional(),
		mtimeMs: z.number().finite().nonnegative().optional(),
		naturalWidth: z.number().finite().positive().optional(),
		naturalHeight: z.number().finite().positive().optional(),
	})
	.strict();
const audioViewSchema = mediaViewSchema.extend({
	durationMs: z.number().finite().nonnegative().optional(),
});

const dataSchemas = {
	text: z
		.object({
			...commonData,
			text: z.string().default(""),
			color: BoardColorIdSchema.default("neutral"),
			fontSize: z
				.number()
				.finite()
				.min(BOARD_TEXT_MIN_FONT_SIZE)
				.max(BOARD_TEXT_MAX_FONT_SIZE)
				.default(BOARD_TEXT_FONT_SIZE),
		})
		.strict(),
	geo: z
		.object({
			...commonData,
			geo: BoardGeoKindSchema.default("rectangle"),
			text: z.string().default(""),
			color: BoardColorIdSchema.default("brand"),
			fillOpacity: z.number().finite().min(0).max(1).default(0),
		})
		.strict(),
	draw: z
		.object({
			...commonData,
			points: z.array(pointSchema).min(1),
			color: BoardColorIdSchema.default("brand"),
			size: strokeSizeSchema.default(BOARD_DRAW_STROKE_SIZE),
		})
		.strict(),
	arrow: z
		.object({
			...commonData,
			start: worldPointSchema,
			end: worldPointSchema,
			bend: z.number().finite().min(-0.85).max(0.85).default(0),
			color: BoardColorIdSchema.default("brand"),
			size: strokeSizeSchema.default(BOARD_ARROW_STROKE_SIZE),
			arrowStart: z.boolean().default(false),
			arrowEnd: z.boolean().default(true),
			label: z.string().default(""),
		})
		.strict(),
	frame: z
		.object({
			...commonData,
			label: z.string().default("Frame"),
			color: BoardColorIdSchema.default("neutral"),
		})
		.strict(),
	image: z
		.object({
			...commonData,
			crop: z
				.object({
					x: z.number().finite().min(0).max(1),
					y: z.number().finite().min(0).max(1),
					w: z.number().finite().min(0).max(1),
					h: z.number().finite().min(0).max(1),
				})
				.strict()
				.optional(),
		})
		.strict(),
	video: z.object(commonData).strict(),
	audio: z.object(commonData).strict(),
	file: z.object(commonData).strict(),
	task: z.object({ ...commonData, taskRunId: z.string().min(1) }).strict(),
} as const;

const fileViewSchema = z
	.object({
		title: z.string().optional(),
		mimeType: z.string().optional(),
		size: z.number().finite().nonnegative().optional(),
		mtimeMs: z.number().finite().nonnegative().optional(),
		excerpt: z.string().optional(),
		coverPath: z.string().optional(),
		coverUrl: z.string().url().optional(),
	})
	.strict();

const taskViewSchema = BoardTaskSnapshotSchema;
const emptyViewSchema = z.object({}).strict();
const viewSchemas = {
	image: mediaViewSchema,
	video: mediaViewSchema,
	audio: audioViewSchema,
	file: fileViewSchema,
	task: taskViewSchema,
	text: emptyViewSchema,
	geo: emptyViewSchema,
	draw: emptyViewSchema,
	arrow: emptyViewSchema,
	frame: emptyViewSchema,
} as const;

export type BoardNodeLike = {
	nodeId?: unknown;
	type: unknown;
	parentId?: unknown;
	orderKey?: unknown;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation?: unknown;
	refKind?: unknown;
	refPath?: unknown;
	refUrl?: unknown;
	view?: unknown;
	style?: unknown;
	data?: unknown;
};

const nodeEnvelopeSchema = z
	.object({
		nodeId: z.string().min(1).max(160),
		type: z.string().min(1).max(40),
		parentId: z.string().min(1).max(160).nullable(),
		orderKey: z.string().max(4096).nullable(),
		x: z.number().finite(),
		y: z.number().finite(),
		width: z.number().finite().positive(),
		height: z.number().finite().positive(),
		rotation: z.number().finite(),
		refKind: z.string().max(40).nullable(),
		refPath: z.string().max(4096).nullable(),
		refUrl: z.string().max(4096).nullable(),
		view: z.record(z.string(), z.unknown()),
		style: z.record(z.string(), z.unknown()),
		data: z.record(z.string(), z.unknown()),
	})
	.strict();

function jsonSchema(schema: z.ZodType): BoardJsonSchema {
	return z.toJSONSchema(schema) as BoardJsonSchema;
}

export const BOARD_NODE_CONTRACT: BoardNodeContract = {
	types: BOARD_NATIVE_NODE_TYPES,
	colors: BOARD_COLOR_IDS,
	geos: BOARD_GEO_KINDS,
	coordinates: {
		frame: "world",
		drawPoints: "frame-local",
		arrowEndpoints: "world",
	},
	references: {
		nodeTypes: ["image", "video", "audio", "file"],
		kind: "space_file",
		pathField: "refPath",
	},
	schemas: {
		envelope: jsonSchema(nodeEnvelopeSchema),
		data: Object.fromEntries(
			BOARD_NATIVE_NODE_TYPES.map((type) => [type, jsonSchema(dataSchemas[type])]),
		) as Record<BoardNativeNodeType, BoardJsonSchema>,
		view: Object.fromEntries(
			BOARD_NATIVE_NODE_TYPES.map((type) => [type, jsonSchema(viewSchemas[type])]),
		) as Record<BoardNativeNodeType, BoardJsonSchema>,
	},
};

function issueDiagnostic(
	issue: z.core.$ZodIssue,
	path: string,
): BoardNodeValidationDiagnostic {
	const fullPath = [path, ...issue.path].join(".");
	const values =
		"values" in issue && Array.isArray(issue.values)
			? issue.values.filter(
					(value: unknown): value is string => typeof value === "string",
				)
			: undefined;
	return {
		severity: "error",
		code: "INVALID_BOARD_NODE",
		message: `${fullPath}: ${issue.message}`,
		path: fullPath,
		...(values?.length ? { allowedValues: values } : {}),
	};
}

function drawGeometryDiagnostic(
	node: BoardNodeLike,
	data: z.infer<typeof dataSchemas.draw>,
	path: string,
): BoardNodeValidationDiagnostic | null {
	const bounds = boardDrawBounds(data.points, data.size);
	const { x: minX, y: minY, width, height } = bounds;
	const tolerance = Math.max(0.01, node.width * 1e-6, node.height * 1e-6);
	if (
		Math.abs(minX) <= tolerance &&
		Math.abs(minY) <= tolerance &&
		Math.abs(width - node.width) <= tolerance &&
		Math.abs(height - node.height) <= tolerance
	) {
		return null;
	}
	return {
		severity: "error",
		code: "INVALID_BOARD_GEOMETRY",
		message: `${path}.data.points must use frame-local coordinates and match the node frame`,
		path: `${path}.data.points`,
		expected: `frame-local bounds x=0, y=0, width=${width}, height=${height}`,
		received: {
			frame: { x: node.x, y: node.y, width: node.width, height: node.height },
			pointsBounds: { x: minX, y: minY, width, height },
		},
		coordinateSpace: "frame-local",
	};
}

export function validateBoardNodeInput(
	node: BoardNodeLike,
	path = "node",
): BoardNodeValidationDiagnostic[] {
	const envelopeResult = nodeEnvelopeSchema.safeParse(node);
	if (!envelopeResult.success) {
		return envelopeResult.error.issues.map((issue) =>
			issueDiagnostic(issue, path),
		);
	}
	if (
		typeof node.type !== "string" ||
		!(BOARD_NATIVE_NODE_TYPES as readonly string[]).includes(node.type)
	) {
		return [
			{
				severity: "error",
				code: "INVALID_BOARD_NODE",
				message: `${path}.type is not supported`,
				path: `${path}.type`,
				expected: "BoardNativeNodeType",
				received: node.type,
				allowedValues: BOARD_NATIVE_NODE_TYPES,
			},
		];
	}
	const type = node.type as BoardNativeNodeType;
	const dataResult = dataSchemas[type].safeParse(node.data ?? {});
	if (!dataResult.success) {
		return dataResult.error.issues.map((issue) =>
			issueDiagnostic(issue, `${path}.data`),
		);
	}
	const viewResult = viewSchemas[type].safeParse(node.view ?? {});
	if (!viewResult.success) {
		return viewResult.error.issues.map((issue) =>
			issueDiagnostic(issue, `${path}.view`),
		);
	}
	if (
		type === "image" ||
		type === "video" ||
		type === "audio" ||
		type === "file"
	) {
		if (
			node.refKind !== "space_file" ||
			typeof node.refPath !== "string" ||
			!node.refPath
		) {
			return [
				{
					severity: "error",
					code: "INVALID_BOARD_NODE",
					message: `${path} requires a space file reference`,
					path: `${path}.refPath`,
					expected: "non-empty refPath with refKind space_file",
				},
			];
		}
	}
	if (type === "draw") {
		const diagnostic = drawGeometryDiagnostic(
			node,
			dataResult.data as z.infer<typeof dataSchemas.draw>,
			path,
		);
		return diagnostic ? [diagnostic] : [];
	}
	if (type === "arrow") {
		const data = dataResult.data as z.infer<typeof dataSchemas.arrow>;
		const expected = boardArrowFrame(data);
		const tolerance = Math.max(0.01, node.width * 1e-6, node.height * 1e-6);
		if (
			Math.abs(node.x - expected.x) > tolerance ||
			Math.abs(node.y - expected.y) > tolerance ||
			Math.abs(node.width - expected.width) > tolerance ||
			Math.abs(node.height - expected.height) > tolerance
		) {
			return [{
				severity: "error",
				code: "INVALID_BOARD_GEOMETRY",
				message: `${path}.data endpoints must use world-space coordinates and match the arrow frame`,
				path: `${path}.data`,
				expected: `world-space curve bounds x=${expected.x}, y=${expected.y}, width=${expected.width}, height=${expected.height}`,
				received: {
					frame: { x: node.x, y: node.y, width: node.width, height: node.height },
					curveBounds: expected,
				},
				coordinateSpace: "world",
			}];
		}
	}
	return [];
}
