function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRepoUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeBootstrap(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.source)) return value;
  const { gitToken: _gitToken, ...source } = value.source;
  return {
    ...value,
    source: {
      ...source,
      ...(source.repoUrl === undefined ? {} : { repoUrl: sanitizeRepoUrl(source.repoUrl) }),
    },
  };
}

export function sanitizeSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!isRecord(meta)) return null;
  const { extraEnv: _extraEnv, ...safeMeta } = meta;
  return {
    ...safeMeta,
    ...(safeMeta.bootstrap === undefined ? {} : { bootstrap: sanitizeBootstrap(safeMeta.bootstrap) }),
  };
}
