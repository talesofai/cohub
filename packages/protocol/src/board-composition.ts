import { z } from "zod";

const idSchema = z.string().min(1).max(160);
const finiteSchema = z.number().finite();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const BOARD_EASINGS = [
	"linear",
	"ease-in-quad",
	"ease-out-quad",
	"ease-in-out-quad",
	"ease-in-cubic",
	"ease-out-cubic",
	"ease-in-out-cubic",
	"ease-out-quart",
	"ease-out-expo",
] as const;

export const BoardEasingSchema = z.enum(BOARD_EASINGS);
export type BoardEasing = z.infer<typeof BoardEasingSchema>;

export const BoardAnimationTargetSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("item"), itemId: idSchema }).strict(),
	z.object({ type: z.literal("effect"), effectId: idSchema }).strict(),
	z.object({ type: z.literal("camera") }).strict(),
	z.object({ type: z.literal("board") }).strict(),
]);
export type BoardAnimationTarget = z.infer<typeof BoardAnimationTargetSchema>;

const vector2Schema = z.object({ x: finiteSchema, y: finiteSchema }).strict();
const scaleSchema = z.union([
	finiteSchema.nonnegative(),
	z.object({ x: finiteSchema.nonnegative(), y: finiteSchema.nonnegative() }).strict(),
]);
export const BOARD_ANIMATION_CHANNELS = {
	"transform.translation": {
		targets: ["item"] as const,
		value: vector2Schema,
		interpolations: ["linear", "step"] as const,
		coordinateSpace: "world-offset" as const,
		unit: "board" as const,
	},
	"transform.rotation": {
		targets: ["item"] as const,
		value: finiteSchema,
		interpolations: ["linear", "step"] as const,
		unit: "radian" as const,
	},
	"transform.scale": {
		targets: ["item"] as const,
		value: scaleSchema,
		interpolations: ["linear", "step"] as const,
		unit: "ratio" as const,
	},
	"style.opacity": {
		targets: ["item"] as const,
		value: finiteSchema.min(0).max(1),
		interpolations: ["linear", "step"] as const,
		unit: "ratio" as const,
	},
} as const;

export type BoardBuiltinAnimationChannel = keyof typeof BOARD_ANIMATION_CHANNELS;
export type BoardTrackInterpolation = "linear" | "step";
export type BoardTimelineFill = "none" | "backwards" | "forwards" | "both";

const BoardTrackKeyframeSchema = z
	.object({
		time: finiteSchema.nonnegative(),
		value: z.unknown(),
		easing: BoardEasingSchema.optional(),
	})
	.strict();

export const BoardTrackSchema = z
	.object({
		id: idSchema,
		target: BoardAnimationTargetSchema,
		channel: z.string().min(1).max(160),
		channelVersion: z.number().int().positive().default(1),
		interpolation: z.enum(["linear", "step"]).default("linear"),
		fill: z.enum(["none", "backwards", "forwards", "both"]).default("none"),
		keyframes: z.array(BoardTrackKeyframeSchema).min(1).max(100_000),
		metadata: jsonObjectSchema.default({}),
	})
	.strict()
	.superRefine((track, context) => {
		let previous = -1;
		for (const [index, keyframe] of track.keyframes.entries()) {
			if (keyframe.time <= previous) {
				context.addIssue({
					code: "custom",
					message: "keyframe times must be strictly increasing",
					path: ["keyframes", index, "time"],
				});
			}
			previous = keyframe.time;
		}
		const channel =
			BOARD_ANIMATION_CHANNELS[track.channel as BoardBuiltinAnimationChannel];
		if (!channel) {
			if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){2,}$/.test(track.channel)) {
				context.addIssue({
					code: "custom",
					message: `unknown channel: ${track.channel}`,
					path: ["channel"],
				});
			}
			return;
		}
		if (!(channel.targets as readonly string[]).includes(track.target.type)) {
			context.addIssue({
				code: "custom",
				message: `${track.channel} cannot target ${track.target.type}`,
				path: ["target"],
			});
		}
		if (
			!(channel.interpolations as readonly string[]).includes(
				track.interpolation,
			)
		) {
			context.addIssue({
				code: "custom",
				message: `${track.channel} does not support ${track.interpolation} interpolation`,
				path: ["interpolation"],
			});
		}
		for (const [index, keyframe] of track.keyframes.entries()) {
			const parsed = channel.value.safeParse(keyframe.value);
			if (!parsed.success) {
				context.addIssue({
					code: "custom",
					message:
						parsed.error.issues[0]?.message ??
						`invalid value for ${track.channel}`,
					path: ["keyframes", index, "value"],
				});
			}
		}
	});
export type BoardTrack = z.infer<typeof BoardTrackSchema>;

const extensionKindSchema = z
	.string()
	.regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/)
	.max(160);

export const BoardProceduralClipSchema = z
	.object({
		id: idSchema,
		kind: extensionKindSchema,
		kindVersion: z.number().int().positive(),
		target: BoardAnimationTargetSchema,
		start: finiteSchema.nonnegative(),
		duration: finiteSchema.positive(),
		layer: z
			.enum(["behind", "content", "front", "screen"])
			.default("content"),
		fill: z
			.enum(["none", "backwards", "forwards", "both"])
			.default("none"),
		easing: BoardEasingSchema.default("linear"),
		params: jsonObjectSchema.default({}),
		assetRefs: z
			.array(
				z
					.object({
						type: z.enum(["space-file", "extension"]),
						ref: z.string().min(1).max(4096),
						digest: z.string().min(16).max(160).optional(),
					})
					.strict(),
			)
			.default([]),
		seed: idSchema,
		metadata: jsonObjectSchema.default({}),
	})
	.strict();
export type BoardProceduralClip = z.infer<typeof BoardProceduralClipSchema>;

export const BoardTimelineMarkerSchema = z
	.object({
		id: idSchema,
		time: finiteSchema.nonnegative(),
		duration: finiteSchema.nonnegative().optional(),
		metadata: jsonObjectSchema.default({}),
	})
	.strict();
export type BoardTimelineMarker = z.infer<typeof BoardTimelineMarkerSchema>;

export const BoardTimelineSchema = z
	.object({
		duration: finiteSchema.nonnegative(),
		tracks: z.array(BoardTrackSchema).max(50_000).default([]),
		clips: z.array(BoardProceduralClipSchema).max(50_000).default([]),
		markers: z.array(BoardTimelineMarkerSchema).max(10_000).default([]),
	})
	.strict()
	.superRefine((timeline, context) => {
		const ids = new Set<string>();
		const channels = new Set<string>();
		for (const [index, track] of timeline.tracks.entries()) {
			if (ids.has(track.id)) {
				context.addIssue({
					code: "custom",
					message: `duplicate timeline id: ${track.id}`,
					path: ["tracks", index, "id"],
				});
			}
			ids.add(track.id);
			const targetId =
				track.target.type === "item"
					? track.target.itemId
					: track.target.type === "effect"
						? track.target.effectId
						: track.target.type;
			const key = `${track.target.type}:${targetId}:${track.channel}`;
			if (channels.has(key)) {
				context.addIssue({
					code: "custom",
					message: `multiple tracks control ${key}`,
					path: ["tracks", index, "channel"],
				});
			}
			channels.add(key);
			for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
				if (keyframe.time > timeline.duration) {
					context.addIssue({
						code: "custom",
						message: "keyframe exceeds timeline duration",
						path: [
							"tracks",
							index,
							"keyframes",
							keyframeIndex,
							"time",
						],
					});
				}
			}
		}
		for (const [index, clip] of timeline.clips.entries()) {
			if (ids.has(clip.id)) {
				context.addIssue({
					code: "custom",
					message: `duplicate timeline id: ${clip.id}`,
					path: ["clips", index, "id"],
				});
			}
			ids.add(clip.id);
			if (clip.start + clip.duration > timeline.duration) {
				context.addIssue({
					code: "custom",
					message: "clip exceeds timeline duration",
					path: ["clips", index, "duration"],
				});
			}
		}
		for (const [index, marker] of timeline.markers.entries()) {
			if (ids.has(marker.id)) {
				context.addIssue({
					code: "custom",
					message: `duplicate timeline id: ${marker.id}`,
					path: ["markers", index, "id"],
				});
			}
			ids.add(marker.id);
			if (marker.time + (marker.duration ?? 0) > timeline.duration) {
				context.addIssue({
					code: "custom",
					message: "marker exceeds timeline duration",
					path: ["markers", index],
				});
			}
		}
	});
export type BoardTimeline = z.infer<typeof BoardTimelineSchema>;

export const BoardCompositionPlaybackSchema = z
	.object({
		loop: z.boolean().default(false),
		endBehavior: z.enum(["hold", "reset"]).default("hold"),
		reducedMotion: z
			.discriminatedUnion("mode", [
				z.object({ mode: z.literal("base") }).strict(),
				z
					.object({
						mode: z.literal("time"),
						time: finiteSchema.nonnegative(),
					})
					.strict(),
				z
					.object({ mode: z.literal("marker"), markerId: idSchema })
					.strict(),
			])
			.default({ mode: "base" }),
	})
	.strict();
export type BoardCompositionPlayback = z.infer<
	typeof BoardCompositionPlaybackSchema
>;

const compositionFields = {
	id: idSchema,
	name: z.string().min(1).max(255),
	timeline: BoardTimelineSchema,
	playback: BoardCompositionPlaybackSchema.default({
		loop: false,
		endBehavior: "hold",
		reducedMotion: { mode: "base" },
	}),
	metadata: jsonObjectSchema.default({}),
};

function validateCompositionFallback(
	composition: {
		timeline: BoardTimeline;
		playback: BoardCompositionPlayback;
	},
	context: z.RefinementCtx,
) {
		const fallback = composition.playback.reducedMotion;
		if (
			fallback.mode === "time" &&
			fallback.time > composition.timeline.duration
		) {
			context.addIssue({
				code: "custom",
				message: "reduced-motion time exceeds timeline duration",
				path: ["playback", "reducedMotion", "time"],
			});
		}
		if (
			fallback.mode === "marker" &&
			!composition.timeline.markers.some(
				(marker) => marker.id === fallback.markerId,
			)
		) {
			context.addIssue({
				code: "custom",
				message: `marker does not exist: ${fallback.markerId}`,
				path: ["playback", "reducedMotion", "markerId"],
			});
		}
}

export const BoardCompositionInputSchema = z
	.object(compositionFields)
	.strict()
	.superRefine(validateCompositionFallback);
export type BoardCompositionInput = z.infer<typeof BoardCompositionInputSchema>;

export const BoardCompositionSchema = z
	.object({
		...compositionFields,
		revision: z.number().int().nonnegative().default(0),
	})
	.strict()
	.superRefine(validateCompositionFallback);
export type BoardComposition = z.infer<typeof BoardCompositionSchema>;
export type BoardAuthoringComposition = BoardCompositionInput & { revision?: number };

/**
 * Accept inspect/get output as apply input while stripping server-owned
 * `revision`. Anything else that looks server-owned (or simply unknown) fails
 * with a pointer at the offending key, so a get → edit → apply round-trip that
 * accidentally carries runtime fields names the culprit instead of a bare
 * "Unrecognized key".
 */
export function parseBoardCompositionInput(value: unknown): BoardCompositionInput {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { revision: _revision, ...input } = value as Record<string, unknown>;
		const result = BoardCompositionInputSchema.safeParse(input);
		if (!result.success) {
			const issue = result.error.issues.find((item) => item.code === "unrecognized_keys");
			if (issue) {
				throw new Error(
					`unknown field in composition input: ${issue.message}. Server-owned fields such as revision are stripped automatically; remove other fields not part of the composition schema`,
				);
			}
			throw result.error;
		}
		return result.data;
	}
	return BoardCompositionInputSchema.parse(value);
}

export type BoardAnimationChannelCapability = {
	id: string;
	version: number;
	targets: readonly BoardAnimationTarget["type"][];
	interpolations: readonly BoardTrackInterpolation[];
	coordinateSpace?: string;
	unit?: string;
	valueSchema: Record<string, unknown>;
};

export const BOARD_ANIMATION_CHANNEL_CAPABILITIES: BoardAnimationChannelCapability[] =
	Object.entries(BOARD_ANIMATION_CHANNELS).map(([id, definition]) => ({
		id,
		version: 1,
		targets: definition.targets,
		interpolations: definition.interpolations,
		...("coordinateSpace" in definition
			? { coordinateSpace: definition.coordinateSpace }
			: {}),
		...("unit" in definition ? { unit: definition.unit } : {}),
		valueSchema: z.toJSONSchema(definition.value) as Record<string, unknown>,
	}));
