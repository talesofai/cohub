export function createRealtimeEventDeduplicator(input: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}) {
  const ttlMs = Math.max(1, input.ttlMs);
  const maxEntries = Math.max(1, input.maxEntries);
  const now = input.now ?? Date.now;
  const expiresAtById = new Map<string, number>();

  const prune = (currentTime: number) => {
    for (const [eventId, expiresAt] of expiresAtById) {
      if (expiresAt <= currentTime) expiresAtById.delete(eventId);
    }
    while (expiresAtById.size >= maxEntries) {
      const oldestId = expiresAtById.keys().next().value;
      if (typeof oldestId !== "string") break;
      expiresAtById.delete(oldestId);
    }
  };

  return {
    accept(eventId: string) {
      const currentTime = now();
      const expiresAt = expiresAtById.get(eventId);
      if (expiresAt && expiresAt > currentTime) return false;
      if (expiresAt) expiresAtById.delete(eventId);
      if (expiresAtById.size >= maxEntries) prune(currentTime);
      expiresAtById.set(eventId, currentTime + ttlMs);
      return true;
    },
    size() {
      return expiresAtById.size;
    },
  };
}
