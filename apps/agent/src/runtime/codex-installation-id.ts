import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const installationIdPromises = new Map<string, Promise<string>>();

function assertInstallationId(value: string, path: string): string {
  const id = value.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`Invalid Codex installation ID in ${path}`);
  }
  return id;
}

async function readInstallationId(path: string): Promise<string> {
  return assertInstallationId(await readFile(path, "utf8"), path);
}

export async function resolveCodexInstallationId(
  path: string,
  generate: () => string = randomUUID,
): Promise<string> {
  try {
    return await readInstallationId(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const candidate = assertInstallationId(generate(), path);
  try {
    await writeFile(path, `${candidate}\n`, { encoding: "utf8", flag: "wx" });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readInstallationId(path);
  }
}

export function getCodexInstallationId(path: string): Promise<string> {
  const existing = installationIdPromises.get(path);
  if (existing) return existing;
  const pending = resolveCodexInstallationId(path);
  installationIdPromises.set(path, pending);
  void pending.catch(() => {
    if (installationIdPromises.get(path) === pending) {
      installationIdPromises.delete(path);
    }
  });
  return pending;
}
