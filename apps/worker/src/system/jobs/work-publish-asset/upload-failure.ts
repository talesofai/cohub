export class WorkAssetUploadError extends Error {
  constructor(
    public readonly cleanupAssetKey: string,
    public override readonly cause: unknown,
  ) {
    super("work asset storage failed", { cause });
  }
}

export async function withWorkAssetUploadCleanupKey<T>(
  cleanupAssetKey: string,
  upload: () => Promise<T>,
): Promise<T> {
  try {
    return await upload();
  } catch (error) {
    throw new WorkAssetUploadError(cleanupAssetKey, error);
  }
}
