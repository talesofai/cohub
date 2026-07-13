export type WorkAssetCleanupFailure = {
  assetKey: string;
  message: string;
};

export class WorkAssetCleanupError extends Error {
  constructor(public readonly failures: WorkAssetCleanupFailure[]) {
    super(`failed to delete ${failures.length} work asset prefix${failures.length === 1 ? "" : "es"}`);
    this.name = "WorkAssetCleanupError";
  }
}

type DeleteWorkAssets = (assetKeys: string[]) => Promise<{ deleted: number }>;

export type WorkAssetKeyScope = {
  env: "dev" | "prod";
  spaceId: string;
  slug: string;
};

const WORK_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const VERSION_SEGMENT_RE = /^[a-f0-9]{12}$/;

const isWorkAssetKeyInScope = (assetKey: string, scope: WorkAssetKeyScope) => {
  if (!assetKey || assetKey.trim() !== assetKey || assetKey.startsWith("/")) return false;
  const segments = assetKey.split("/");
  const offset = scope.env === "prod" ? 0 : 1;
  if (segments.length !== offset + 5) return false;
  if (scope.env !== "prod" && segments[0] !== scope.env) return false;
  return (
    segments[offset] === "w" &&
    segments[offset + 1] === scope.spaceId &&
    segments[offset + 2] === scope.slug &&
    WORK_SLUG_RE.test(scope.slug) &&
    VERSION_SEGMENT_RE.test(segments[offset + 3] ?? "") &&
    segments[offset + 4] === "index.html"
  );
};

export function collectWorkAssetKeys(
  assetKeys: Array<string | null | undefined>,
  scope: WorkAssetKeyScope,
) {
  const failures: WorkAssetCleanupFailure[] = [];
  const uniqueAssetKeys: string[] = [];
  const seenAssetKeys = new Set<string>();

  for (const assetKey of assetKeys) {
    if (assetKey === null || assetKey === undefined) continue;
    if (!isWorkAssetKeyInScope(assetKey, scope)) {
      failures.push({ assetKey, message: "work asset key is outside the work space scope" });
      continue;
    }
    if (seenAssetKeys.has(assetKey)) continue;
    seenAssetKeys.add(assetKey);
    uniqueAssetKeys.push(assetKey);
  }

  if (failures.length > 0) throw new WorkAssetCleanupError(failures);
  return uniqueAssetKeys;
}

export function collectHistoricalWorkAssetKeys(
  versions: Array<{ id: string; assetKey: string | null }>,
  currentVersionId: string | null,
  scope: WorkAssetKeyScope,
) {
  const historicalVersions = versions.filter(
    (version) => version.id !== currentVersionId && version.assetKey !== null,
  );
  return {
    assetKeys: collectWorkAssetKeys(
      historicalVersions.map((version) => version.assetKey),
      scope,
    ),
    versionIds: historicalVersions.map((version) => version.id),
  };
}

export function excludeReferencedWorkAssetKeys(
  assetKeys: string[],
  referencedAssetKeys: Array<string | null>,
) {
  const referenced = new Set(referencedAssetKeys.filter((assetKey): assetKey is string => assetKey !== null));
  return assetKeys.filter((assetKey) => !referenced.has(assetKey));
}

export async function deleteWorkAssetKeys(
  assetKeys: Array<string | null | undefined>,
  scope: WorkAssetKeyScope,
  deleteWorkAssets: DeleteWorkAssets,
) {
  const uniqueAssetKeys = collectWorkAssetKeys(assetKeys, scope);
  if (uniqueAssetKeys.length === 0) return { assetKeys: 0, objects: 0 };
  try {
    const result = await deleteWorkAssets(uniqueAssetKeys);
    if (!Number.isSafeInteger(result.deleted) || result.deleted < 0) {
      throw new Error("invalid deleted object count");
    }
    return { assetKeys: uniqueAssetKeys.length, objects: result.deleted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkAssetCleanupError(uniqueAssetKeys.map((assetKey) => ({ assetKey, message })));
  }
}

export async function detachWorkWithAssetCleanupScheduled(input: {
  assetKeys: Array<string | null | undefined>;
  scope: WorkAssetKeyScope;
  scheduleCleanup: (assetKeys: string[]) => Promise<void>;
  deleteRecords: () => Promise<void>;
}) {
  const assetKeys = collectWorkAssetKeys(input.assetKeys, input.scope);
  if (assetKeys.length > 0) await input.scheduleCleanup(assetKeys);
  await input.deleteRecords();
  return { assetKeys };
}
