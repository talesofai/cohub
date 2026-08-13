export function resolveSessionPromptIntent(
	hasActiveTurn: boolean,
): "followup" | "steer" {
	return hasActiveTurn ? "steer" : "followup";
}

export function resolveSteerGenerationTurnId(input: {
	queuedTurnId: string;
	delivery:
		| { mode: "checkpoint"; targetTurnId: string }
		| { mode: "after_run" };
}) {
	return input.delivery.mode === "checkpoint"
		? input.delivery.targetTurnId
		: input.queuedTurnId;
}

export function resolveAcceptedPromptGenerationTurnId(input: {
	turnId: string;
	meta: unknown;
}) {
	if (
		!input.meta ||
		typeof input.meta !== "object" ||
		Array.isArray(input.meta)
	)
		return input.turnId;
	const delivery = (input.meta as Record<string, unknown>).agentTurnSteer;
	if (!delivery || typeof delivery !== "object" || Array.isArray(delivery))
		return input.turnId;
	const record = delivery as Record<string, unknown>;
	return record.mode === "checkpoint" &&
		typeof record.targetTurnId === "string" &&
		record.targetTurnId.trim()
		? record.targetTurnId.trim()
		: input.turnId;
}
