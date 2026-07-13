export function getWorkAssetReservationCleanupDecision(
  state: string,
  leaseExpiresAt: number,
  now: number,
) {
  if (state === "committed" || state === "cleaned") return "skip" as const;
  if (state === "pending") return leaseExpiresAt > now ? "retry" as const : "claim" as const;
  if (state === "abandoned" || state === "claimed") return "claim" as const;
  throw new Error(`invalid work asset reservation state: ${state}`);
}

export function hasActiveWorkAssetWriterLease(writerLeaseExpiresAt: Date | null, now: number) {
  return writerLeaseExpiresAt !== null && writerLeaseExpiresAt.getTime() > now;
}

export function shouldDeferWorkAssetCleanupForReferences(
  deferWhileReferenced: boolean,
  requestedAssetCount: number,
  unreferencedAssetCount: number,
) {
  return deferWhileReferenced && unreferencedAssetCount !== requestedAssetCount;
}
