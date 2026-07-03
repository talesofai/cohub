import ignore from "ignore";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GIT_DIR_PATTERN = /^\.git(?:\/|$)/;

export type SpaceFsVisibility = "full" | "filtered";

export type SpaceGitignoreFilter = {
  isIgnored(path: string, options?: { isDirectory?: boolean }): boolean;
};

const normalizeFilterPath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");
const asDirectoryPath = (path: string) => path.endsWith("/") ? path : `${path}/`;

export async function createSpaceGitignoreFilter(root: string): Promise<SpaceGitignoreFilter> {
  const matcher = ignore();

  try {
    const content = await readFile(join(root, ".gitignore"), "utf8");
    matcher.add(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") throw error;
  }

  return {
    isIgnored(path, options) {
      const normalized = normalizeFilterPath(path);
      return normalized.length > 0 && (
        GIT_DIR_PATTERN.test(normalized) ||
        matcher.ignores(normalized) ||
        (options?.isDirectory === true && matcher.ignores(asDirectoryPath(normalized)))
      );
    },
  };
}
