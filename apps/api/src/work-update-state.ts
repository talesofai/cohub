export function getWorkUpdateVersionState(
  lockedWork: {
    assetKey: string | null;
    currentVersionId: string | null;
    latestVersion: number;
    publishedAt: Date | null;
  },
  nextStatus: string,
  now: Date,
) {
  return {
    assetKey: nextStatus === "published" ? lockedWork.assetKey : null,
    currentVersionId: lockedWork.currentVersionId,
    latestVersion: lockedWork.latestVersion,
    publishedAt: nextStatus === "published" ? (lockedWork.publishedAt ?? now) : null,
  };
}
