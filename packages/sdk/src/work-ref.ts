import { parseSpaceSlug, parseUsername } from "@cohub/protocol/public-identifiers";

/**
 * Accepts every way a Work is named across Cohub — id, management URL, public
 * URL, `cohub://works` URI, or `username/space/work` — and normalizes it.
 *
 * Public and mention forms may carry launch state (`?query#hash`); it is kept
 * separately so it can be forwarded to the Work while the stable identity stays
 * clean.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkPublicRef = {
  username: string;
  spaceSlug: string;
  workSlug: string;
};

export type ParsedWorkRef = ({ id: string } | WorkPublicRef) & {
  /** Query string including `?`, when the reference carried one. */
  search?: string;
  /** Hash including `#`, when the reference carried one. */
  hash?: string;
};

export const isWorkId = (value: string): boolean => UUID_PATTERN.test(value.trim());

function decodePart(value: string) {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

function publicRef(parts: string[]): WorkPublicRef | null {
  if (parts.length !== 3) return null;
  const [usernameRaw = "", spaceSlugRaw = "", workSlugRaw = ""] = parts.map(decodePart);
  const username = parseUsername(usernameRaw);
  const spaceSlug = parseSpaceSlug(spaceSlugRaw);
  const workSlug = parseSpaceSlug(workSlugRaw);
  return username && spaceSlug && workSlug ? { username, spaceSlug, workSlug } : null;
}

function launchState(url: URL) {
  return {
    ...(url.search ? { search: url.search } : {}),
    ...(url.hash ? { hash: url.hash } : {}),
  };
}

function parseUrlRef(value: string): ParsedWorkRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol === "cohub:" && url.hostname === "works") {
    const ref = publicRef(parts);
    return ref ? { ...ref, ...launchState(url) } : null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (
    parts.length === 4 &&
    parts[0] === "spaces" &&
    UUID_PATTERN.test(parts[1] ?? "") &&
    parts[2] === "works" &&
    UUID_PATTERN.test(parts[3] ?? "")
  ) {
    return { id: parts[3] as string };
  }
  if (parts.length === 4 && parts[2] === "w") {
    const ref = publicRef([parts[0] as string, parts[1] as string, parts[3] as string]);
    return ref ? { ...ref, ...launchState(url) } : null;
  }
  return null;
}

export class WorkRefParseError extends Error {
  constructor() {
    super("Work must be an id, public URL, cohub://works URI, or username/space/work reference");
    this.name = "WorkRefParseError";
  }
}

export function parseWorkRef(input: string): ParsedWorkRef {
  const value = input.trim();
  if (UUID_PATTERN.test(value)) return { id: value };

  const parsedUrl = parseUrlRef(
    value.includes("://") ? value : value.startsWith("/") ? `https://cohub.invalid${value}` : value,
  );
  if (parsedUrl) return parsedUrl;

  const parts = value.split("/").filter(Boolean);
  const parsedPublic = parts.length === 3 ? publicRef(parts) : null;
  if (parsedPublic) return parsedPublic;

  throw new WorkRefParseError();
}

export function formatWorkRef(ref: ParsedWorkRef): string {
  return "id" in ref ? ref.id : `${ref.username}/${ref.spaceSlug}/${ref.workSlug}`;
}
