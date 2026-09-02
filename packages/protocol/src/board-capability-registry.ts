import {
	BOARD_BUILTIN_CLIP_KINDS,
	BOARD_BUILTIN_EFFECT_KINDS,
	DEFAULT_BOARD_RENDER_LIMITS,
	type BoardRenderCost,
} from "./board-constants.js";
import type { BoardDiagnostic, BoardEffect } from "./board.js";
import { BoardCameraFocusParamsSchema } from "./board.js";
import type { BoardProceduralClip } from "./board-composition.js";

const CLIPS = new Set<string>(BOARD_BUILTIN_CLIP_KINDS);
const EFFECTS = new Set<string>(BOARD_BUILTIN_EFFECT_KINDS);
const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function validateBuiltinBoardClip(
	clip: BoardProceduralClip,
	path = "clip",
): BoardDiagnostic[] {
	if (!CLIPS.has(clip.kind)) return [];
	const errors: BoardDiagnostic[] = [];
	const error = (message: string, suffix: string, coordinateSpace?: BoardDiagnostic["coordinateSpace"], code = "INVALID_BOARD_CLIP") => {
		errors.push({ severity: "error", code, message, path: `${path}.${suffix}`, ...(coordinateSpace ? { coordinateSpace } : {}) });
	};
	if (
		(clip.kind.startsWith("motion.") || clip.kind.startsWith("draw.") || clip.kind === "text.reveal" || clip.kind === "effects.trail") &&
		clip.target.type !== "item"
	) error(`${clip.kind} must target an item`, "target");
	if (clip.kind.startsWith("camera.") && clip.target.type !== "camera") {
		error(`${clip.kind} must target the camera`, "target");
	}
	if (clip.kind === "motion.path") {
		const points = clip.params.points;
		if (!Array.isArray(points) || points.length < 2 || points.length > 10_000) {
			error("motion path must contain 2 to 10000 world-offset points", "params.points", "world-offset");
		} else {
			for (const [index, point] of points.entries()) {
				if (!record(point) || !finite(point.x) || !finite(point.y)) {
					error("motion path point must contain finite x and y", `params.points.${index}`, "world-offset");
				}
			}
		}
	}
	if (clip.kind === "effects.particles") {
		const count = clip.params.count;
		if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > DEFAULT_BOARD_RENDER_LIMITS.particles) {
			error(`particle count must be an integer from 1 to ${DEFAULT_BOARD_RENDER_LIMITS.particles}`, "params.count", undefined, "INVALID_PARTICLE_COUNT");
		}
		const bounds = clip.params.bounds;
		if (!record(bounds) || !finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
			error("particles require positive finite world bounds", "params.bounds", "world", "PARTICLE_BOUNDS_REQUIRED");
		}
	}
	if (clip.kind === "camera.focus") {
		const parsed = BoardCameraFocusParamsSchema.safeParse(clip.params);
		if (!parsed.success) error(parsed.error.issues[0]?.message ?? "invalid camera focus", "params", "world");
	}
	return errors;
}

export function validateBuiltinBoardEffect(
	effect: Pick<BoardEffect, "kind" | "target">,
	path = "effect",
): BoardDiagnostic[] {
	if (!EFFECTS.has(effect.kind) || effect.target.type === "item") return [];
	return [{
		severity: "error",
		code: "INVALID_BOARD_EFFECT",
		message: `${effect.kind} must target an item`,
		path: `${path}.target`,
	}];
}

export function estimateBuiltinBoardClipCost(
	clip: Pick<BoardProceduralClip, "kind" | "params">,
): Partial<BoardRenderCost> {
	switch (clip.kind) {
		case "effects.particles": {
			const count = Number.isSafeInteger(clip.params.count) ? Math.max(0, clip.params.count as number) : 0;
			return { particles: count, vertices: count * 4, dynamicVertices: count * 4, drawCalls: 1, bufferBytes: count * 48, simulationSteps: count };
		}
		case "effects.trail":
			return { vertices: 32, dynamicVertices: 32, drawCalls: 1, bufferBytes: 1_024, simulationSteps: 16 };
		case "effects.impact":
		case "effects.flash":
			return { vertices: 64, drawCalls: 1 };
		case "draw.reveal":
			return { drawCalls: 1, dynamicVertices: 1 };
		case "motion.path":
			return { simulationSteps: Array.isArray(clip.params.points) ? clip.params.points.length : 0 };
		default:
			return {};
	}
}
