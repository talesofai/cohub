import { isIP } from "node:net";

const RUNTIME_PEER_PATH = "/internal/runtime-relay";

const normalizedPath = (value: string): string => {
  const withoutTrailingSlash = value.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
};

const effectivePort = (url: URL): string => url.port || (url.protocol === "wss:" ? "443" : "80");

const ipv4IsPrivate = (hostname: string): boolean => {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
};

const ipv6IsPrivate = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  // IPv4-mapped loopback/private addresses are normalized by URL as IPv6.
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && mapped[1]) return ipv4IsPrivate(mapped[1]);
  // RFC 4193 unique-local and RFC 4291 link-local ranges are the only IPv6
  // ranges used for an in-cluster gateway endpoint. Do not allow unspecified,
  // multicast, or globally routable IPv6 addresses here.
  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb");
};

const isPrivateGatewayHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const addressType = isIP(normalized);
  return addressType === 4 ? ipv4IsPrivate(normalized) : addressType === 6 && ipv6IsPrivate(normalized);
};

const isLoopbackGatewayHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || (isIP(normalized) === 4 && normalized.startsWith("127."));
};

const parseRelayUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
};

/**
 * Check a persisted Gateway endpoint before the worker secret is attached.
 * Gateway pods advertise a private IP; the configured relay host remains the
 * trust anchor for deployments that use a DNS/service endpoint instead.
 */
export const isTrustedRuntimeRelayEndpoint = (candidateValue: string, configuredValue: string): boolean => {
  const candidate = parseRelayUrl(candidateValue);
  const configured = parseRelayUrl(configuredValue);
  if (!candidate || !configured) return false;
  if (candidate.protocol !== configured.protocol || effectivePort(candidate) !== effectivePort(configured)) return false;
  if (normalizedPath(candidate.pathname) !== RUNTIME_PEER_PATH) return false;
  const sameHost = candidate.hostname.toLowerCase() === configured.hostname.toLowerCase();
  const privateHost = isPrivateGatewayHost(candidate.hostname);
  const loopbackHost = isLoopbackGatewayHost(candidate.hostname);
  return sameHost || (privateHost && (!loopbackHost || isLoopbackGatewayHost(configured.hostname)));
};

/**
 * Select a relay base without ever routing the worker secret to an untrusted
 * persisted coordinate. A malformed/untrusted database value falls back to
 * the operator-configured relay, and an invalid configured value fails closed.
 */
export const selectRuntimeRelayEndpoint = (candidateValue: string | null | undefined, configuredValue: string): string => {
  const configured = parseRelayUrl(configuredValue);
  if (!configured) throw new Error("configured local runtime relay URL is invalid");
  if (!candidateValue?.trim()) return configured.toString().replace(/\/+$/, "");
  if (!isTrustedRuntimeRelayEndpoint(candidateValue.trim(), configuredValue)) {
    return configured.toString().replace(/\/+$/, "");
  }
  return new URL(candidateValue.trim()).toString().replace(/\/+$/, "");
};
