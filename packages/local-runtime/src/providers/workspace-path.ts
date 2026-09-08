import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Canonical workspace name used on the provider-neutral runtime wire. */
export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

/** Platform-correct lexical containment check for canonicalized paths. */
export function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function virtualWorkspaceSuffix(value: string): string | null {
  // Runtime paths use POSIX spelling, while native Windows tools may hand us
  // the same alias with backslashes. Normalize only for alias detection; the
  // resulting suffix is resolved by the host platform below.
  const normalized = value.replace(/\\/g, "/");
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return "";
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1);
  }
  return null;
}

/**
 * Resolve the path spellings accepted by local provider tools. The optional
 * workspaceRoot is the physical replica root; when omitted, cwd is the root
 * for embedders that already operate on physical paths.
 */
export function resolveWorkspacePath(
  raw: string,
  cwd: string,
  workspaceRoot = cwd,
): string {
  let value = raw.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    value = join(homedir(), value.slice(2));
  }
  if (/^file:\/\//i.test(value)) value = fileURLToPath(value);

  const root = resolve(workspaceRoot);
  const virtualSuffix = virtualWorkspaceSuffix(value);
  if (virtualSuffix !== null) return resolve(root, virtualSuffix);
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/** Return the physical fence root used for a provider session. */
export function workspaceFenceRoot(cwd: string, workspaceRoot?: string): string {
  return resolve(workspaceRoot ?? cwd);
}
