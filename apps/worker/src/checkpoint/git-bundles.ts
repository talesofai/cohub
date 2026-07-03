import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadObjectFileIfMissing } from "./assets.js";
import { runGitWithOutput } from "./git.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";

export type UserGitRemote = {
  name: string;
  url: string;
  credentialSanitized: boolean;
};

export type UserGitRepoBundle = {
  sha256: string;
  size: number;
  objectKey: string;
};

export type UserGitRepoRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  fingerprint: string | null;
  bundle: UserGitRepoBundle | null;
  remotes: UserGitRemote[];
};

type BundleCache = {
  version: 1;
  repos: Record<string, {
    fingerprint: string;
    bundle: UserGitRepoBundle;
  }>;
};

const cacheFileName = "git-bundle-cache.v1.json";

const sha256File = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
});

const sha256Text = (value: string) => createHash("sha256").update(value).digest("hex");

const buildGitBundleObjectKey = (sha256: string) =>
  `checkpoint-assets/git-bundles/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.bundle`;

async function loadCache(systemDir: string): Promise<BundleCache> {
  const raw = await readFile(join(systemDir, cacheFileName), "utf8").catch(() => null);
  if (!raw) return { version: 1, repos: {} };
  try {
    const parsed = JSON.parse(raw) as BundleCache;
    return parsed?.version === 1 && parsed.repos ? parsed : { version: 1, repos: {} };
  } catch {
    return { version: 1, repos: {} };
  }
}

async function saveCache(systemDir: string, cache: BundleCache) {
  const path = join(systemDir, cacheFileName);
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`);
}

const sanitizeRemoteUrl = (value: string): { url: string; credentialSanitized: boolean } => {
  const trimmed = value.trim();
  if (!trimmed) return { url: "", credentialSanitized: false };

  try {
    const url = new URL(trimmed);
    const hadCredentials = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    return { url: url.toString(), credentialSanitized: hadCredentials };
  } catch {
    // Conservative fallback for non-URL remotes. Handles:
    //   https://token@host/org/repo.git
    //   custom-scheme://user:token@host/org/repo.git
    //   token@host:org/repo.git (scp-like)
    let sanitized = trimmed.replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1");
    sanitized = sanitized.replace(/^([^@\s]+)@([^:\s]+):(.*)$/u, "$2:$3");
    return { url: sanitized, credentialSanitized: sanitized !== trimmed };
  }
};

async function getRemotes(repoDir: string): Promise<UserGitRemote[]> {
  const names = await runGitWithOutput(["remote"], repoDir).then((result) => result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), () => []);
  const remotes = await Promise.all(names.map(async (name) => {
    const url = await runGitWithOutput(["remote", "get-url", name], repoDir).then((result) => result.stdout.trim(), () => "");
    const sanitized = sanitizeRemoteUrl(url);
    return { name, url: sanitized.url, credentialSanitized: sanitized.credentialSanitized };
  }));
  return remotes;
}

async function getRepoFingerprint(repoDir: string) {
  const head = await runGitWithOutput(["rev-parse", "HEAD"], repoDir).then((result) => result.stdout.trim(), () => null);
  if (!head) return { head: null, branch: null, dirty: false, fingerprint: null };
  const branchResult = await runGitWithOutput(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).then((result) => result.stdout.trim(), () => null);
  const branch = branchResult && branchResult !== "HEAD" ? branchResult : null;
  const refs = await runGitWithOutput(["for-each-ref", "--format=%(refname) %(objectname)"], repoDir).then((result) => result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort().join("\n"), () => "");
  const dirty = await runGitWithOutput(["status", "--porcelain"], repoDir).then((result) => result.stdout.trim().length > 0, () => false);
  return { head, branch, dirty, fingerprint: sha256Text(`${head}\n${refs}\n`) };
}

async function createBundle(input: { repoDir: string; tmpDir: string }) {
  await mkdir(input.tmpDir, { recursive: true, mode: 0o775 });
  const bundlePath = join(input.tmpDir, `${crypto.randomUUID()}.bundle`);
  try {
    await runGitWithOutput(["bundle", "create", bundlePath, "--all"], input.repoDir);
    const [sha256, st] = await Promise.all([sha256File(bundlePath), stat(bundlePath)]);
    const objectKey = buildGitBundleObjectKey(sha256);
    await uploadObjectFileIfMissing({ filePath: bundlePath, objectKey, size: st.size, mimeType: "application/octet-stream" });
    return { sha256, size: st.size, objectKey };
  } finally {
    await rm(bundlePath, { force: true }).catch(() => undefined);
  }
}

export async function collectUserGitRepos(input: {
  workspaceDir: string;
  systemDir: string;
  tmpDir: string;
  repoPaths: string[];
}): Promise<UserGitRepoRecord[]> {
  const cache = await loadCache(input.systemDir);
  const bundleTmpDir = getWorkerLocalTmpDir("git-bundles", crypto.randomUUID());
  const records: UserGitRepoRecord[] = [];

  try {
    await ensureWorkerLocalTmpDir(bundleTmpDir);
    for (const repoPath of [...new Set(input.repoPaths)].sort()) {
      const repoDir = repoPath === "." ? input.workspaceDir : join(input.workspaceDir, repoPath);
      const [fingerprint, remotes] = await Promise.all([getRepoFingerprint(repoDir), getRemotes(repoDir)]);
      let bundle: UserGitRepoBundle | null = null;

      if (fingerprint.fingerprint) {
        const cached = cache.repos[repoPath];
        if (cached?.fingerprint === fingerprint.fingerprint) {
          bundle = cached.bundle;
        } else {
          bundle = await createBundle({ repoDir, tmpDir: bundleTmpDir });
          cache.repos[repoPath] = { fingerprint: fingerprint.fingerprint, bundle };
        }
      }

      records.push({
        path: repoPath,
        head: fingerprint.head,
        branch: fingerprint.branch,
        dirty: fingerprint.dirty,
        fingerprint: fingerprint.fingerprint,
        bundle,
        remotes,
      });
    }

    await saveCache(input.systemDir, cache);
    return records;
  } finally {
    await removeWorkerLocalTmpDir(bundleTmpDir).catch(() => undefined);
  }
}
