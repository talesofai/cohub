export function isRealtimeAuthExpired(
  expiresAtMs: number | undefined,
  now = Date.now(),
): boolean {
  return expiresAtMs !== undefined && expiresAtMs <= now;
}

export function realtimeConnectionTtlSeconds(
  expiresAtMs: number | undefined,
  maxTtlSeconds: number,
  now = Date.now(),
): number {
  if (expiresAtMs === undefined) return maxTtlSeconds;
  return Math.max(0, Math.min(maxTtlSeconds, Math.ceil((expiresAtMs - now) / 1000)));
}
