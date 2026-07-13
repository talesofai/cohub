export function assertWorkAssetWriterLeaseResponse(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("leaseMs" in value) ||
    typeof value.leaseMs !== "number" ||
    !Number.isSafeInteger(value.leaseMs) ||
    value.leaseMs <= 0
  ) {
    throw new Error("work asset writer lease API returned an invalid response");
  }
  return { ok: true as const, leaseMs: value.leaseMs };
}

export function isWorkAssetWriterLeaseUsable(
  leaseExpiresAt: number,
  now: number,
  requiredRemainingMs: number,
) {
  return leaseExpiresAt - now > requiredRemainingMs;
}

export function getWorkAssetWriterLeaseExpiresAt(requestedAt: number, leaseMs: number) {
  return requestedAt + leaseMs;
}
