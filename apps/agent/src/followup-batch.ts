type FollowupTurn = {
  meta: unknown;
};

function getSystemInstructions(turn: FollowupTurn): string | null {
  if (!turn.meta || typeof turn.meta !== "object" || Array.isArray(turn.meta)) return null;
  const value = (turn.meta as Record<string, unknown>).systemInstructions;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getMergeableFollowupPrefix<T extends FollowupTurn>(turns: readonly T[]): T[] {
  const [firstTurn] = turns;
  if (!firstTurn) return [];
  const first = getSystemInstructions(firstTurn);
  const boundary = turns.findIndex((turn) => getSystemInstructions(turn) !== first);
  return boundary === -1 ? [...turns] : turns.slice(0, boundary);
}
