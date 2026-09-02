/**
 * Free-arrow geometry.
 *
 * An arrow is a standalone annotation stroke between two world points — it does
 * not relate nodes. Node relations are `BoardConnection`s, which resolve their
 * geometry from the nodes they join (see ./connections). Keeping the two apart is
 * what makes each one simple: an arrow owns absolute coordinates and needs no
 * lookup, while a connection owns no coordinates at all.
 */

import {
	type Rect,
	type WorldPoint,
	worldPoint,
} from "../geometry.js";
import {
	boardArrowBounds,
	boardArrowFrame,
	boardResolveArrow,
	boardSampleResolvedArrow,
} from "@cohub/protocol";
import type { BoardArrowItem, BoardFrame, BoardPoint } from "@cohub/protocol/board-document";

export type ResolvedArrow = {
	start: WorldPoint;
	end: WorldPoint;
	/** Quadratic control point (already bent); the midpoint when bend is 0. */
	control: WorldPoint;
};

/** Resolve an arrow's endpoints and its bent control point. */
export function resolveArrow(item: BoardArrowItem): ResolvedArrow {
	const resolved = boardResolveArrow(item);
	return {
		start: worldPoint(resolved.start.x, resolved.start.y),
		end: worldPoint(resolved.end.x, resolved.end.y),
		control: worldPoint(resolved.control.x, resolved.control.y),
	};
}

/** Sample an arrow's quadratic curve into world points. */
export function sampleArrow(resolved: ResolvedArrow, segments: number): WorldPoint[] {
	return boardSampleResolvedArrow(resolved, segments).map((point) =>
		worldPoint(point.x, point.y),
	);
}

/** World bounds of an arrow, padded for its stroke. */
export function arrowBounds(item: BoardArrowItem): Rect {
	return boardArrowBounds(item);
}

/** The frame an arrow should carry, derived from its endpoints. */
export function arrowFrame(item: BoardArrowItem): BoardFrame {
	return boardArrowFrame(item);
}

/** Distance from a world point to an arrow's curve (hit testing). */
export function distanceToArrow(item: BoardArrowItem, point: WorldPoint): number {
	const samples = sampleArrow(resolveArrow(item), 16);
	let min = Number.POSITIVE_INFINITY;
	for (let index = 0; index < samples.length - 1; index += 1) {
		const from = samples[index];
		const to = samples[index + 1];
		if (!from || !to) continue;
		const distance = segmentDistance(point, from, to);
		if (distance < min) min = distance;
	}
	return min;
}

function segmentDistance(p: WorldPoint, a: WorldPoint, b: WorldPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Translate an arrow by a delta, keeping its frame consistent. */
export function translateArrow(item: BoardArrowItem, dx: number, dy: number): BoardArrowItem {
	const move = (point: BoardPoint): BoardPoint => ({ x: point.x + dx, y: point.y + dy });
	const next: BoardArrowItem = { ...item, start: move(item.start), end: move(item.end) };
	return { ...next, frame: arrowFrame(next) };
}
