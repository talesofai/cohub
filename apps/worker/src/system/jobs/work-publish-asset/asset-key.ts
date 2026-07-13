export function usesReservedWorkAssetProtocol(assetKey: string | undefined) {
  return typeof assetKey === "string";
}

export function resolveWorkAssetObjectKey(
  assetKey: string | undefined,
  createLegacyObjectKey: () => string,
) {
  return assetKey ?? createLegacyObjectKey();
}
