/**
 * Renderer-independent Board geometry contracts.
 *
 * Renderers build their own primitives from these results, but validation and
 * item factories use the same coordinate and bounds rules.
 */

import type { BoardFrame, BoardPoint, DrawPoint } from "./board-document.js";

export type BoardArrowGeometryInput = {
	start: BoardPoint;
	end: BoardPoint;
	bend: number;
	size: number;
};

export type BoardArrowPoint = BoardPoint;

export type BoardResolvedArrow = {
	start: BoardArrowPoint;
	end: BoardArrowPoint;
	control: BoardArrowPoint;
};

/** Radius of a draw sample in world units given stroke size and pressure. */
export function boardDrawSampleRadius(size: number, pressure: number): number {
	const clamped = Math.min(1, Math.max(0, pressure));
	return Math.max(0.5, (size / 2) * (0.5 + clamped));
}

/** Convert persisted frame-local draw points to world-space authoring points. */
export function boardDrawPointsToWorld(
	points: readonly DrawPoint[],
	x: number,
	y: number,
): DrawPoint[] {
	return points.map((point) => ({ x: point.x + x, y: point.y + y, p: point.p }));
}

/** Convert world-space authoring points to persisted frame-local points. */
export function boardDrawPointsToLocal(
	points: readonly DrawPoint[],
	x: number,
	y: number,
): DrawPoint[] {
	return points.map((point) => ({ x: point.x - x, y: point.y - y, p: point.p }));
}

/** Exact local bounds required by the draw node contract. */
export function boardDrawBounds(
	points: readonly DrawPoint[],
	size: number,
): Pick<BoardFrame, "x" | "y" | "width" | "height"> {
	if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		const radius = boardDrawSampleRadius(size, point.p);
		minX = Math.min(minX, point.x - radius);
		minY = Math.min(minY, point.y - radius);
		maxX = Math.max(maxX, point.x + radius);
		maxY = Math.max(maxY, point.y + radius);
	}
	return {
		x: minX,
		y: minY,
		width: Math.max(1, maxX - minX),
		height: Math.max(1, maxY - minY),
	};
}

/** Resolve the world-space quadratic curve represented by a free arrow. */
export function boardResolveArrow(input: BoardArrowGeometryInput): BoardResolvedArrow {
	const start = input.start;
	const end = input.end;
	const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	if (!input.bend) return { start, end, control: mid };
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy) || 1;
	const offset = input.bend * length;
	return {
		start,
		end,
		control: {
			x: mid.x + (-dy / length) * offset,
			y: mid.y + (dx / length) * offset,
		},
	};
}

/** Sample an already resolved arrow curve. */
export function boardSampleResolvedArrow(
	resolved: BoardResolvedArrow,
	segments: number,
): BoardArrowPoint[] {
	const { start, control, end } = resolved;
	const count = Math.max(1, Math.floor(segments));
	const points: BoardArrowPoint[] = [];
	for (let index = 0; index <= count; index += 1) {
		const t = index / count;
		const mt = 1 - t;
		points.push({
			x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
			y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
		});
	}
	return points;
}

/** Sample an arrow curve for bounds, hit testing, and rendering adapters. */
export function boardSampleArrow(
	input: BoardArrowGeometryInput,
	segments: number,
): BoardArrowPoint[] {
	return boardSampleResolvedArrow(boardResolveArrow(input), segments);
}

/** World bounds of the curve, padded for the stroke. */
export function boardArrowBounds(input: BoardArrowGeometryInput): Pick<BoardFrame, "x" | "y" | "width" | "height"> {
	const { start, control, end } = boardResolveArrow(input);
	const points = [start, end];
	for (const axis of ["x", "y"] as const) {
		const denominator = start[axis] - 2 * control[axis] + end[axis];
		if (Math.abs(denominator) < 1e-12) continue;
		const t = (start[axis] - control[axis]) / denominator;
		if (t > 0 && t < 1) {
			const mt = 1 - t;
			points.push({
				x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
				y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
			});
		}
	}
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	const pad = Math.max(8, input.size * 2);
	return { x: minX - pad, y: minY - pad, width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) };
}

export function boardArrowFrame(input: BoardArrowGeometryInput): BoardFrame {
	return { ...boardArrowBounds(input), rotation: 0 };
}
