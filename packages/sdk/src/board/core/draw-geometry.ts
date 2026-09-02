/**
 * Freehand stroke geometry — pure functions over raw draw points.
 *
 * We persist raw samples (see DrawPoint) and derive everything else here:
 * bounds, simplified paths for low zoom (LOD), a variable-width outline polygon
 * for rendering, and a hit test. Keeping this renderer-independent means the
 * stroke can be re-rendered at any detail level and tested without a GPU.
 */

import type { WorldPoint } from "../geometry.js";
import {
	boardDrawBounds,
	boardDrawSampleRadius,
} from "@cohub/protocol";
import type { DrawPoint } from "@cohub/protocol/board-document";
import { getStroke } from "perfect-freehand";

/** Radius of a sample in world units given the stroke size and pressure. */
export const sampleRadius = boardDrawSampleRadius;

/** Axis-aligned bounds of a stroke in its local space, padded by stroke width. */
export const computeDrawBounds = boardDrawBounds;

/**
 * Ramer–Douglas–Peucker simplification. Reduces point count for low-zoom
 * rendering without touching the persisted raw samples. Returns indices into
 * the input so callers can keep pressure alongside the simplified path.
 */
export function simplifyDrawIndices(
	points: DrawPoint[],
	tolerance: number,
): number[] {
	const n = points.length;
	if (n <= 2 || tolerance <= 0) return points.map((_, i) => i);
	const keep = new Array<boolean>(n).fill(false);
	keep[0] = true;
	keep[n - 1] = true;
	const stack: Array<[number, number]> = [[0, n - 1]];
	while (stack.length > 0) {
		const segment = stack.pop();
		if (!segment) break;
		const [start, end] = segment;
		let maxDist = -1;
		let index = -1;
		const a = points[start];
		const b = points[end];
		if (!a || !b) continue;
		for (let i = start + 1; i < end; i += 1) {
			const point = points[i];
			if (!point) continue;
			const d = perpendicularDistance(point, a, b);
			if (d > maxDist) {
				maxDist = d;
				index = i;
			}
		}
		if (maxDist > tolerance && index !== -1) {
			keep[index] = true;
			stack.push([start, index], [index, end]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i += 1) if (keep[i]) out.push(i);
	return out;
}

function perpendicularDistance(
	point: DrawPoint,
	a: DrawPoint,
	b: DrawPoint,
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
	const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
	const projX = a.x + t * dx;
	const projY = a.y + t * dy;
	return Math.hypot(point.x - projX, point.y - projY);
}

/**
 * Build a closed outline for callers that need a path representation.
 * Interactive rendering uses `buildStrokeRibbonGeometry` below because a single
 * outline is unsafe when a freehand path folds back over itself.
 */
export function buildStrokeOutline(
	points: DrawPoint[],
	size: number,
): Array<{ x: number; y: number }> {
	const n = points.length;
	if (n === 0) return [];
	const first = points[0];
	if (!first) return [];
	if (n === 1) {
		const r = sampleRadius(size, first.p);
		const p = first;
		const k = r * Math.SQRT1_2;
		return [
			{ x: p.x, y: p.y - r },
			{ x: p.x + k, y: p.y - k },
			{ x: p.x + r, y: p.y },
			{ x: p.x + k, y: p.y + k },
			{ x: p.x, y: p.y + r },
			{ x: p.x - k, y: p.y + k },
			{ x: p.x - r, y: p.y },
			{ x: p.x - k, y: p.y - k },
		];
	}
	return getStroke(
		points.map((point) => [point.x, point.y, point.p]),
		{
			size: Math.max(1, size),
			thinning: 0.5,
			smoothing: 0.5,
			streamline: 0,
			simulatePressure: false,
			last: true,
			start: { cap: true },
			end: { cap: true },
		},
	).map(([x, y]) => ({ x, y }));
}

const RIBBON_CIRCLE_SIDES = 8;

/** Whether a sample needs a round join rather than the neighboring segment caps. */
export function isStrokeCorner(
	points: readonly DrawPoint[],
	index: number,
): boolean {
	if (index === 0 || index === points.length - 1) return true;
	const before = points[index - 1];
	const point = points[index];
	const after = points[index + 1];
	if (!before || !point || !after) return false;
	const ax = point.x - before.x;
	const ay = point.y - before.y;
	const bx = after.x - point.x;
	const by = after.y - point.y;
	const aLength = Math.hypot(ax, ay);
	const bLength = Math.hypot(bx, by);
	if (aLength < 1e-6 || bLength < 1e-6) return true;
	return (ax * bx + ay * by) / (aLength * bLength) < 0.92;
}

export type StrokeRibbonGeometry = {
	positions: Float32Array;
	indices: Uint32Array;
	uvs: Float32Array;
	/** Normalized distance along the centerline for reveal animations. */
	progress: Float32Array;
};

/**
 * Tessellate a freehand stroke as independent, convex primitives.
 *
 * A whole-path polygon is deliberately avoided: a path that folds back can make
 * its outline self-intersect, and GPU polygon triangulation then creates a large
 * accidental fill. Segment quads plus round point joins overlap safely instead.
 */
export function buildStrokeRibbonGeometry(
	points: readonly DrawPoint[],
	size: number,
): StrokeRibbonGeometry {
	const positions: number[] = [];
	const indices: number[] = [];
	const uvs: number[] = [];
	const progress: number[] = [];
	if (points.length === 0) {
		return {
			positions: new Float32Array(),
			indices: new Uint32Array(),
			uvs: new Float32Array(),
			progress: new Float32Array(),
		};
	}

	const lengths = new Array<number>(points.length).fill(0);
	for (let i = 1; i < points.length; i += 1) {
		const from = points[i - 1];
		const to = points[i];
		if (from && to) {
			lengths[i] =
				(lengths[i - 1] ?? 0) + Math.hypot(to.x - from.x, to.y - from.y);
		}
	}
	const total = Math.max(lengths.at(-1) ?? 0, 1e-6);
	const addVertex = (x: number, y: number, at: number) => {
		const normalized = at / total;
		positions.push(x, y);
		uvs.push(normalized, 0);
		progress.push(normalized);
		return positions.length / 2 - 1;
	};
	const addTriangle = (a: number, b: number, c: number) => indices.push(a, b, c);
	const addRoundPoint = (point: DrawPoint, at: number) => {
		const radius = sampleRadius(size, point.p);
		const center = addVertex(point.x, point.y, at);
		const circle: number[] = [];
		for (let side = 0; side < RIBBON_CIRCLE_SIDES; side += 1) {
			const angle = (side / RIBBON_CIRCLE_SIDES) * Math.PI * 2;
			circle.push(addVertex(
				point.x + Math.cos(angle) * radius,
				point.y + Math.sin(angle) * radius,
				at,
			));
		}
		for (let side = 0; side < RIBBON_CIRCLE_SIDES; side += 1) {
			addTriangle(center, circle[side] as number, circle[(side + 1) % RIBBON_CIRCLE_SIDES] as number);
		}
	};
	for (let i = 0; i < points.length; i += 1) {
		const point = points[i];
		if (!point) continue;
		if (isStrokeCorner(points, i)) addRoundPoint(point, lengths[i] ?? 0);
		if (i === points.length - 1) continue;
		const next = points[i + 1];
		if (!next) continue;
		const dx = next.x - point.x;
		const dy = next.y - point.y;
		const length = Math.hypot(dx, dy);
		if (length < 1e-6) continue;
		const normalX = -dy / length;
		const normalY = dx / length;
		const radius = sampleRadius(size, point.p);
		const leftA = addVertex(point.x + normalX * radius, point.y + normalY * radius, lengths[i] ?? 0);
		const rightA = addVertex(point.x - normalX * radius, point.y - normalY * radius, lengths[i] ?? 0);
		const nextRadius = sampleRadius(size, next.p);
		const leftB = addVertex(next.x + normalX * nextRadius, next.y + normalY * nextRadius, lengths[i + 1] ?? 0);
		const rightB = addVertex(next.x - normalX * nextRadius, next.y - normalY * nextRadius, lengths[i + 1] ?? 0);
		addTriangle(leftA, rightA, leftB);
		addTriangle(rightA, rightB, leftB);
	}

	return {
		positions: new Float32Array(positions),
		indices: new Uint32Array(indices),
		uvs: new Float32Array(uvs),
		progress: new Float32Array(progress),
	};
}

/**
 * Distance from a world point to the stroke's polyline, in the shape's local
 * space. Used for hit testing: a hit registers within half the stroke width plus
 * a small tolerance. `local` is the point expressed in the draw item's frame.
 */
export function distanceToStroke(
	points: DrawPoint[],
	local: WorldPoint,
): number {
	if (points.length === 0) return Number.POSITIVE_INFINITY;
	const first = points[0];
	if (!first) return Number.POSITIVE_INFINITY;
	if (points.length === 1) return Math.hypot(local.x - first.x, local.y - first.y);
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < points.length - 1; i += 1) {
		const from = points[i];
		const to = points[i + 1];
		if (!from || !to) continue;
		const d = perpendicularDistance({ x: local.x, y: local.y, p: 0 }, from, to);
		if (d < min) min = d;
	}
	return min;
}
