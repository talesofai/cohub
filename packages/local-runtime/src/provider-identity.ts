import { createHash } from "node:crypto";

/** Maximum size of a provider/session/event identity on the runtime wire. */
export const MAX_PROVIDER_ID_BYTES = 255;

/**
 * C0/C1 controls and DEL are unsafe in IDs: they can corrupt logs, framing,
 * or command arguments even when JSON itself escapes them correctly.
 */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Node encodes lone UTF-16 surrogates as U+FFFD; reject that lossy boundary. */
export function hasUnpairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function providerIdProblem(value: unknown): "type" | "empty" | "bytes" | "control" | "unicode" | null {
  if (typeof value !== "string") return "type";
  const normalized = value.trim();
  if (!normalized) return "empty";
  if (hasUnpairedSurrogates(normalized)) return "unicode";
  if (hasControlCharacters(normalized)) return "control";
  if (Buffer.byteLength(normalized, "utf8") > MAX_PROVIDER_ID_BYTES) return "bytes";
  return null;
}

/** Return a strict, trimmed provider identity or null when it is unsafe. */
export function providerIdValue(value: unknown): string | null {
  if (providerIdProblem(value) !== null || typeof value !== "string") return null;
  return value.trim();
}

/** Throw a consistently worded error at a native SDK boundary. */
export function assertProviderId(value: unknown, label: string): string {
  const problem = providerIdProblem(value);
  if (problem === "type") throw new Error(`${label} must be a string`);
  if (problem === "empty") throw new Error(`${label} must be non-empty`);
  if (problem === "bytes") throw new Error(`${label} exceeds the size limit`);
  if (problem === "control") throw new Error(`${label} contains control characters`);
  if (problem === "unicode") throw new Error(`${label} is not valid UTF-8`);
  return (value as string).trim();
}

/** Return a prefix whose UTF-8 encoding fits the requested byte budget. */
export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = "";
  for (const character of value) {
    const next = result + character;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    result = next;
  }
  return result;
}

function stripUnsafeCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    result += value.charAt(index);
  }
  return result;
}

/**
 * Build a bounded, deterministic event identity. Unsafe/oversized values are
 * hashed in full rather than truncated, so distinct native events remain
 * distinct after crossing the runtime wire.
 */
export function providerEventId(...parts: Array<string | number | undefined | null>): string | undefined {
  const raw = parts
    .filter((part): part is string | number => part !== undefined && part !== null && String(part).length > 0)
    .map(String)
    .join(":");
  if (!raw) return undefined;
  if (providerIdProblem(raw) === null) return raw;

  // JSON.stringify preserves lone-surrogate distinctions that Buffer's UTF-8
  // encoder would otherwise collapse to the same replacement character.
  const digestInput = JSON.stringify(raw);
  const digest = createHash("sha256").update(digestInput, "utf8").digest("hex");
  const readable = stripUnsafeCharacters(raw);
  const prefix = utf8Prefix(readable, MAX_PROVIDER_ID_BYTES - digest.length - 1);
  return `${prefix}:${digest}`;
}

/** Convert an untrusted native ID into a bounded wire-safe identity. */
export function boundedProviderId(value: unknown, fallback?: string): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return fallback;
  return providerEventId(normalized) ?? fallback;
}
