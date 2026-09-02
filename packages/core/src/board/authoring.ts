import type { BoardNodeInput } from "@cohub/protocol";

export {
	applyBoardItemPatch,
	boardAuthoringItemToNode,
	boardNodeToAuthoringItem,
	BoardItemValidationError,
} from "@cohub/protocol/board-codec";

/** Preserve storage fields outside the semantic Item contract during a partial edit. */
export function preserveOpaqueNodeFields(
	before: BoardNodeInput,
	compiled: BoardNodeInput,
	options: {
		preserveSource?: boolean;
		preserveStyle?: boolean;
	} = {},
): BoardNodeInput {
	const data = { ...before.data, ...compiled.data };
	if (!("locked" in compiled.data)) delete data.locked;
	if (!("metadata" in compiled.data)) delete data.metadata;
	// `undefined` means "patch did not mention the field" → keep the stored
	// value; `false` means "patch explicitly cleared it" → do not restore.
	const preserveSource = options.preserveSource !== false;
	const preserveStyle = options.preserveStyle !== false;
	return {
		...compiled,
		refKind: preserveSource ? compiled.refKind ?? before.refKind : compiled.refKind,
		refPath: preserveSource ? compiled.refPath ?? before.refPath : compiled.refPath,
		refUrl: preserveSource ? compiled.refUrl ?? before.refUrl : compiled.refUrl,
		view: preserveSource ? { ...before.view, ...compiled.view } : compiled.view,
		style: preserveStyle ? { ...before.style, ...compiled.style } : compiled.style,
		data,
	};
}

/** Return only storage fields that changed between two compiled Items. */
export function boardNodePatch(
	before: BoardNodeInput,
	after: BoardNodeInput,
): Partial<Omit<BoardNodeInput, "nodeId">> {
	const patch: Partial<Omit<BoardNodeInput, "nodeId">> = {};
	for (const key of [
		"type", "parentId", "orderKey", "x", "y", "width", "height", "rotation",
		"refKind", "refPath", "refUrl", "view", "style", "data",
	] as const) {
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
			(patch as Record<string, unknown>)[key] = after[key];
		}
	}
	return patch;
}
