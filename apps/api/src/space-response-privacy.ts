function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePublicHttpUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function sanitizeRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Remove credentials from the bootstrap source while preserving public state. */
export function sanitizeSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;

  const bootstrap = isRecord(meta.bootstrap) ? meta.bootstrap : null;
  const source = bootstrap && isRecord(bootstrap.source) ? bootstrap.source : null;
  if (!source || typeof source.repoUrl !== "string") return { ...meta };

  return {
    ...meta,
    bootstrap: {
      ...bootstrap,
      source: {
        ...source,
        repoUrl: sanitizeRepoUrl(source.repoUrl),
      },
    },
  };
}

function sanitizeWorkMeta(meta: unknown): Record<string, unknown> | null {
  const sanitized = sanitizeSpaceMeta(meta);
  if (!sanitized) return null;

  // Work account-list responses expose only state useful to a viewer. Keep
  // the public profile and bootstrap progress, never arbitrary owner metadata.
  const result: Record<string, unknown> = {};
  if (isRecord(sanitized.publicProfile)) {
    result.publicProfile = {
      avatarUrl: sanitizePublicHttpUrl(sanitized.publicProfile.avatarUrl),
    };
  }
  if (isRecord(sanitized.bootstrap)) {
    const bootstrap = sanitized.bootstrap;
    const safeBootstrap: Record<string, unknown> = {};
    for (const key of ["status", "stage", "startedAt", "finishedAt"] as const) {
      if (key in bootstrap) safeBootstrap[key] = bootstrap[key];
    }
    if (isRecord(bootstrap.source)) {
      const source = bootstrap.source;
      const safeSource: Record<string, unknown> = {};
      for (const key of ["type", "ref", "checkpointId", "repoUrl"] as const) {
        if (key in source) safeSource[key] = source[key];
      }
      if (Object.keys(safeSource).length > 0) safeBootstrap.source = safeSource;
    }
    if (Object.keys(safeBootstrap).length > 0) result.bootstrap = safeBootstrap;
  }
  return result;
}

export function stripSensitiveSpaceFields(item: Record<string, unknown>): Record<string, unknown> {
  const { storageRepoName, sandboxStatus, access, meta, ...rest } = item;
  void storageRepoName;
  void sandboxStatus;
  void access;
  return { ...rest, meta: sanitizeWorkMeta(meta) };
}
