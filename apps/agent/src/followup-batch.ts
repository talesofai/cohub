type FollowupTurn = {
  userUuid?: string | null;
  meta: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function getExecutionProfile(turn: FollowupTurn): string {
  const meta = asRecord(turn.meta);
  return stableStringify({
    userUuid: turn.userUuid?.trim() || null,
    actorUserId: typeof meta.userId === "string" ? meta.userId.trim() || null : null,
    source: meta.source ?? null,
    llm: meta.llm ?? null,
    model: meta.model ?? null,
    provider: meta.provider ?? null,
    requestedThinkingLevel: meta.requestedThinkingLevel ?? null,
    generationPolicy: meta.generationPolicy ?? null,
    accessMode: meta.accessMode ?? null,
    env: meta.env ?? null,
    systemInstructions: typeof meta.systemInstructions === "string"
      ? meta.systemInstructions.trim() || null
      : null,
    billing: meta.billing ?? null,
    context: meta.context ?? null,
  });
}

export function getMergeableFollowupPrefix<T extends FollowupTurn>(turns: readonly T[]): T[] {
  const [firstTurn] = turns;
  if (!firstTurn) return [];
  const first = getExecutionProfile(firstTurn);
  const boundary = turns.findIndex((turn) => getExecutionProfile(turn) !== first);
  return boundary === -1 ? [...turns] : turns.slice(0, boundary);
}
