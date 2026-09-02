import { z } from "zod";
import { BoardConnectionPatchSchema, BoardConnectionSchema, type BoardConnection } from "./board-connection.js";
import { BoardCompositionInputSchema, type BoardComposition, type BoardCompositionInput } from "./board-composition.js";
import { BoardEffectInputSchema, type BoardEffect, type BoardEffectInput } from "./board-effect.js";
import {
	BOARD_STROKE_MAX_SIZE,
	BOARD_STROKE_MIN_SIZE,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
} from "./board-constants.js";
export const BOARD_AUTHORING_COLOR_IDS = ["brand", "neutral", "black", "white", "blue", "green", "amber", "violet", "rose"] as const;
export const BOARD_AUTHORING_GEO_KINDS = ["rectangle", "rounded", "ellipse", "diamond", "triangle"] as const;

const idSchema = z.string().min(1).max(160);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const finiteSchema = z.number().finite();
const extensionTypeSchema = z
	.string()
	.regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
	.max(160);

const BoardAuthoringPositionSchema = z.object({
	x: finiteSchema,
	y: finiteSchema,
}).strict();
const BoardAuthoringSizeSchema = z.object({
	width: finiteSchema.positive(),
	height: finiteSchema.positive(),
}).strict();
const BoardAuthoringPositionPatchSchema = z.object({
	x: finiteSchema.optional(),
	y: finiteSchema.optional(),
}).strict();
const pointSchema = z.object({
	x: finiteSchema,
	y: finiteSchema,
	p: finiteSchema.min(0).max(1).default(0.5),
}).strict();
const worldPointSchema = z.object({ x: finiteSchema, y: finiteSchema }).strict();
const cropSchema = z.object({
	x: finiteSchema.min(0).max(1),
	y: finiteSchema.min(0).max(1),
	w: finiteSchema.min(0).max(1),
	h: finiteSchema.min(0).max(1),
}).strict();

export const BoardItemStyleSchema = z.object({
	color: z.enum(BOARD_AUTHORING_COLOR_IDS).optional(),
	strokeWidth: finiteSchema.min(BOARD_STROKE_MIN_SIZE).max(BOARD_STROKE_MAX_SIZE).optional(),
	fillOpacity: finiteSchema.min(0).max(1).optional(),
}).strict();
export type BoardItemStyle = z.infer<typeof BoardItemStyleSchema>;

const sourceSnapshotSchema = z.record(z.string(), z.unknown());
export function isSafeBoardSourcePath(value: string): boolean {
	return value.length > 0 &&
		value.length <= 4096 &&
		!value.startsWith("/") &&
		!value.startsWith("\\") &&
		!value.includes("\\") &&
		value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const BoardItemSourceSchema = z.object({
	kind: z.literal("space-file"),
	path: z.string().refine(isSafeBoardSourcePath, "source path must be a safe relative Board file path"),
	snapshot: sourceSnapshotSchema.optional(),
}).strict();
export type BoardItemSource = z.infer<typeof BoardItemSourceSchema>;

const baseFields = {
	id: idSchema,
	position: BoardAuthoringPositionSchema.default({ x: 0, y: 0 }),
	rotation: finiteSchema.default(0),
	parentId: idSchema.nullable().optional(),
	locked: z.boolean().optional(),
	metadata: jsonObjectSchema.optional(),
};

const sizedBaseFields = {
	...baseFields,
	size: BoardAuthoringSizeSchema.optional(),
};
const styledBaseFields = {
	...sizedBaseFields,
	style: BoardItemStyleSchema.optional(),
};
const { position: _positionField, size: _sizeField, ...strokeBaseFields } = sizedBaseFields;
const strokeStyledBaseFields = {
	...strokeBaseFields,
	rotation: z.literal(0).default(0),
	style: BoardItemStyleSchema.optional(),
};

export const BoardTextAuthoringItemSchema = z.object({
	...styledBaseFields,
	type: z.literal("text"),
	props: z.object({
		text: z.string().default(""),
		fontSize: finiteSchema
			.min(BOARD_TEXT_MIN_FONT_SIZE)
			.max(BOARD_TEXT_MAX_FONT_SIZE)
			.default(BOARD_TEXT_FONT_SIZE),
	}).strict(),
}).strict();

export const BoardGeoAuthoringItemSchema = z.object({
	...styledBaseFields,
	type: z.literal("geo"),
	props: z.object({
		shape: z.enum(BOARD_AUTHORING_GEO_KINDS).default("rectangle"),
		text: z.string().default(""),
	}).strict(),
}).strict();

export const BoardDrawAuthoringItemSchema = z.object({
	...strokeStyledBaseFields,
	type: z.literal("draw"),
	props: z.object({ points: z.array(pointSchema).min(1) }).strict(),
}).strict();

export const BoardArrowAuthoringItemSchema = z.object({
	...strokeStyledBaseFields,
	type: z.literal("arrow"),
	props: z.object({
		start: worldPointSchema,
		end: worldPointSchema,
		bend: finiteSchema.min(-0.85).max(0.85).default(0),
		arrowStart: z.boolean().default(false),
		arrowEnd: z.boolean().default(true),
		label: z.string().default(""),
	}).strict(),
}).strict();

export const BoardFrameAuthoringItemSchema = z.object({
	...styledBaseFields,
	type: z.literal("frame"),
	props: z.object({ label: z.string().default("Frame") }).strict(),
}).strict();

const fileBackedFields = {
	...sizedBaseFields,
	style: z.object({}).strict().optional(),
	source: BoardItemSourceSchema,
};

export const BoardImageAuthoringItemSchema = z.object({
	...fileBackedFields,
	type: z.literal("image"),
	props: z.object({ crop: cropSchema.optional() }).strict(),
}).strict();
export const BoardVideoAuthoringItemSchema = z.object({
	...fileBackedFields,
	type: z.literal("video"),
	props: z.object({}).strict(),
}).strict();
export const BoardAudioAuthoringItemSchema = z.object({
	...fileBackedFields,
	type: z.literal("audio"),
	props: z.object({}).strict(),
}).strict();
export const BoardFileAuthoringItemSchema = z.object({
	...fileBackedFields,
	type: z.literal("file"),
	props: z.object({}).strict(),
}).strict();

export const BoardTaskAuthoringItemSchema = z.object({
	...sizedBaseFields,
	type: z.literal("task"),
	props: z.object({
		taskRunId: z.string().min(1),
		snapshot: z.record(z.string(), z.unknown()),
	}).strict(),
	style: z.object({}).strict().optional(),
}).strict();

export const BOARD_AUTHORING_ITEM_TYPES = [
	"image", "video", "audio", "file", "task", "text", "geo", "draw", "arrow", "frame",
] as const;

const builtinItemSchemas = [
	BoardTextAuthoringItemSchema,
	BoardGeoAuthoringItemSchema,
	BoardDrawAuthoringItemSchema,
	BoardArrowAuthoringItemSchema,
	BoardFrameAuthoringItemSchema,
	BoardImageAuthoringItemSchema,
	BoardVideoAuthoringItemSchema,
	BoardAudioAuthoringItemSchema,
	BoardFileAuthoringItemSchema,
	BoardTaskAuthoringItemSchema,
] as const;

export const BoardBuiltinAuthoringItemSchema = z.discriminatedUnion(
	"type",
	builtinItemSchemas,
);

export const BoardExtensionAuthoringItemSchema = z.object({
	...sizedBaseFields,
	type: extensionTypeSchema,
	kindVersion: z.number().int().positive(),
	props: jsonObjectSchema,
	style: jsonObjectSchema.optional(),
	source: z.object({
		kind: z.string().min(1).max(80),
		ref: z.string().min(1).max(4096),
		snapshot: jsonObjectSchema.optional(),
	}).strict().optional(),
}).strict();

export const BoardAuthoringItemSchema = z.union([
	BoardBuiltinAuthoringItemSchema,
	BoardExtensionAuthoringItemSchema,
]);
export type BoardAuthoringItem = z.infer<typeof BoardAuthoringItemSchema>;

/** JSON Merge Patch semantics, constrained to the stable Item envelope. */
export const BoardItemPatchSchema = z.object({
	position: BoardAuthoringPositionPatchSchema.optional(),
	size: BoardAuthoringSizeSchema.nullable().optional(),
	rotation: finiteSchema.optional(),
	parentId: idSchema.nullable().optional(),
	locked: z.boolean().nullable().optional(),
	props: jsonObjectSchema.optional(),
	style: jsonObjectSchema.nullable().optional(),
	source: jsonObjectSchema.nullable().optional(),
	metadata: jsonObjectSchema.nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "item patch is empty");
export type BoardItemPatch = z.infer<typeof BoardItemPatchSchema>;

const BoardConnectionInputSchema = BoardConnectionSchema;
const stripServerFields = (value: unknown): unknown => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { boardId: _boardId, revision: _revision, ...input } = value as Record<string, unknown>;
	return input;
};
const BoardEffectCommandInputSchema = z.preprocess(stripServerFields, BoardEffectInputSchema);
const BoardCompositionCommandInputSchema = z.preprocess(stripServerFields, BoardCompositionInputSchema);

export const BoardSemanticCommandSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("board.patch"), patch: z.object({
		title: z.string().min(1).max(255).optional(),
		metadata: jsonObjectSchema.nullable().optional(),
		metadataPatch: jsonObjectSchema.optional(),
	}).strict().refine((patch) => Object.keys(patch).length > 0, "board patch is empty") }).strict(),
	z.object({ type: z.literal("item.create"), item: BoardAuthoringItemSchema }).strict(),
	z.object({ type: z.literal("item.patch"), itemId: idSchema, patch: BoardItemPatchSchema }).strict(),
	z.object({ type: z.literal("item.replace"), itemId: idSchema, item: BoardAuthoringItemSchema }).strict(),
	z.object({ type: z.literal("item.delete"), itemId: idSchema, cascade: z.boolean().default(false) }).strict(),
	z.object({ type: z.literal("item.reorder"), itemId: idSchema, index: z.number().int().nonnegative() }).strict(),
	z.object({ type: z.literal("connection.create"), connection: BoardConnectionInputSchema }).strict(),
	z.object({ type: z.literal("connection.patch"), connectionId: idSchema, patch: BoardConnectionPatchSchema }).strict(),
	z.object({ type: z.literal("connection.delete"), connectionId: idSchema }).strict(),
	z.object({ type: z.literal("effect.apply"), effect: BoardEffectCommandInputSchema }).strict(),
	z.object({ type: z.literal("effect.delete"), effectId: idSchema }).strict(),
	z.object({ type: z.literal("composition.apply"), composition: BoardCompositionCommandInputSchema }).strict(),
	z.object({ type: z.literal("composition.delete"), compositionId: idSchema }).strict(),
]);
export type BoardSemanticCommand = z.infer<typeof BoardSemanticCommandSchema>;
export type BoardSemanticEffect = Omit<BoardEffect, "boardId" | "revision">;
export type BoardSemanticComposition = Omit<BoardComposition, "revision">;

export const BoardSemanticMutationSchema = z.object({
	mutationId: idSchema,
	baseVersion: z.number().int().nonnegative(),
	clientId: idSchema.optional(),
	undoGroupId: idSchema.optional(),
	/** Validate (including server-side reference checks) without writing. */
	dryRun: z.boolean().default(false),
	commands: z.array(BoardSemanticCommandSchema).min(1).max(50_000),
}).strict();
export type BoardSemanticMutation = z.infer<typeof BoardSemanticMutationSchema>;

export const BOARD_AUTHORING_ITEM_CAPABILITIES = {
	types: BOARD_AUTHORING_ITEM_TYPES,
	colors: BOARD_AUTHORING_COLOR_IDS,
	shapes: BOARD_AUTHORING_GEO_KINDS,
	coordinates: {
		position: "world" as const,
		drawPoints: "world" as const,
		arrowEndpoints: "world" as const,
	},
};

export const BoardAuthoringReadInputSchema = z.object({
	include: z.array(z.enum(["items", "connections", "effects", "compositions", "playback"])).optional(),
	itemIds: z.array(idSchema).max(50_000).optional(),
	connectionIds: z.array(idSchema).max(50_000).optional(),
	effectIds: z.array(idSchema).max(50_000).optional(),
	compositionIds: z.array(idSchema).max(50_000).optional(),
	viewport: z.object({
		x: finiteSchema,
		y: finiteSchema,
		width: finiteSchema.positive(),
		height: finiteSchema.positive(),
	}).optional(),
}).strict();
export type BoardAuthoringReadInput = z.infer<typeof BoardAuthoringReadInputSchema>;

export type BoardAuthoringSnapshot = {
	board: {
		id: string;
		title: string;
		version: number;
		metadata: Record<string, unknown>;
		updatedAt: string | null;
	};
	items?: BoardAuthoringItem[];
	connections?: BoardConnection[];
	effects?: Array<BoardEffectInput & { revision: number }>;
	compositions?: Array<BoardCompositionInput & { revision: number }>;
	playback?: import("./board.js").BoardPlaybackSnapshot | null;
};
