type DeleteObjectsResult = {
  Errors?: Array<{ Key?: string; Code?: string; Message?: string }>;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const workAssetPrefixFromObjectKey = (objectKey: string) => {
  const normalized = objectKey.replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) throw new Error("invalid work asset object key");
  return normalized.slice(0, slash + 1);
};

export function assertDeleteObjectsSucceeded(objectKeys: string[], result: DeleteObjectsResult) {
  const errors = result.Errors ?? [];
  if (errors.length > 0) {
    const failedKeys = errors.map((error) => error.Key).filter((key): key is string => Boolean(key));
    throw new Error(
      `failed to delete ${errors.length} work asset object${errors.length === 1 ? "" : "s"}` +
        (failedKeys.length > 0 ? `: ${failedKeys.join(", ")}` : ""),
    );
  }
  return objectKeys.length;
}

export function createCloudflareWorkAssetPrefix(cdnBaseUrl: string, objectKey: string) {
  const baseUrl = new URL(cdnBaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("invalid work asset CDN base URL");
  }
  const assetPrefix = workAssetPrefixFromObjectKey(objectKey).replace(/\/$/, "");
  const basePath = baseUrl.pathname.replace(/^\/+|\/+$/g, "");
  return [baseUrl.host, basePath, assetPrefix].filter(Boolean).join("/");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export async function purgeCloudflareWorkAssetPrefixes(input: {
  zoneId: string;
  apiToken: string;
  prefixes: string[];
  fetchImpl?: FetchLike;
}) {
  if (!input.zoneId || !input.apiToken || input.prefixes.length === 0) {
    throw new Error("work asset CDN purge is not configured");
  }
  const prefixes = Array.from(new Set(input.prefixes));
  const hosts = Array.from(new Set(prefixes.map((prefix) => prefix.split("/")[0]).filter(Boolean)));
  if (hosts.length !== 1 || prefixes.some((prefix) => !prefix.startsWith(`${hosts[0]}/`))) {
    throw new Error("work asset CDN prefixes must share one host");
  }
  const purgeBody = prefixes.length <= 30 ? { prefixes } : { hosts };
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(purgeBody),
    },
  );
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.errors) ||
    body.errors.length > 0
  ) {
    throw new Error(`Cloudflare rejected work asset cache purge with status ${response.status}`);
  }
}
