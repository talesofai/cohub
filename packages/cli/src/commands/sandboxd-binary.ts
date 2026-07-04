import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// The sandboxd binary version is pinned independently of the CLI package: it
// only needs to change when apps/sandbox changes, and the agent-sandbox wire
// protocol ("1") guarantees backward compatibility.
//
// IMPORTANT: this must point at a tag whose CDN artifacts have already been
// published by .github/workflows/sandbox-binaries-build.yml. Only bump it AFTER
// that tag's publish-cdn job has succeeded, otherwise `sandbox up` 404s on the
// default download.
export const SANDBOXD_VERSION = "v1.80.2";

const BINARY_NAME = "cohub-sandboxd";

// Public CDN prefix hosting the release archives (the repo is private, so the
// GitHub Release assets are not publicly downloadable). Overridable for staging
// or self-hosting.
const cdnBaseUrl = (): string =>
  (process.env.COHUB_SANDBOXD_CDN_BASE_URL?.trim() || "https://public.cohub.run/sandboxd").replace(/\/+$/, "");

const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 5 * 60 * 1000;

// Map Node's platform/arch to the Go GOOS/GOARCH used in release asset names.
const GOOS_BY_PLATFORM: Record<string, string> = { darwin: "darwin", linux: "linux" };
const GOARCH_BY_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export class SandboxdDownloadError extends Error {
  override name = "SandboxdDownloadError";
}

type Target = { goos: string; goarch: string };

const resolveTarget = (): Target => {
  const goos = GOOS_BY_PLATFORM[process.platform];
  const goarch = GOARCH_BY_ARCH[process.arch];
  if (!goos || !goarch) {
    throw new SandboxdDownloadError(
      `Unsupported platform ${process.platform}/${process.arch}. Set COHUB_SANDBOXD_BIN to a locally built binary.`,
    );
  }
  return { goos, goarch };
};

const cacheDir = (version: string): string => join(homedir(), ".cache", "cohub", "sandboxd", version);
const cachedBinaryPath = (version: string): string => join(cacheDir(version), BINARY_NAME);
const archiveName = (version: string, target: Target): string =>
  `${BINARY_NAME}_${version}_${target.goos}_${target.goarch}.tar.gz`;

const isExecutableFile = async (path: string): Promise<boolean> => {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isFile());
};

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

// Run `fn` under a single AbortController whose timeout spans the entire body
// read (not just the response headers), and normalize any network / timeout
// failure into a user-readable SandboxdDownloadError.
const withTimeout = async <T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof SandboxdDownloadError) throw err;
    if (controller.signal.aborted) {
      throw new SandboxdDownloadError(`${what} timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    }
    throw new SandboxdDownloadError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
};

// Download a URL straight to disk. The timeout covers the full stream, so a
// stalled body can never hang indefinitely.
const downloadToFile = (url: string, accept: string, destPath: string): Promise<void> =>
  withTimeout(`Download of ${url}`, async (signal) => {
    const response = await fetch(url, { signal, headers: { accept } });
    if (!response.ok) throw new SandboxdDownloadError(`Download failed (${response.status}) for ${url}`);
    if (!response.body) throw new SandboxdDownloadError(`Empty response body for ${url}`);
    // Cast: Node's web-stream typings diverge from the DOM lib bundled by tsc.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
  });

// Fetch a small text resource (the checksum manifest) under the same timeout.
const fetchText = (url: string, accept: string): Promise<string> =>
  withTimeout(`Download of ${url}`, async (signal) => {
    const response = await fetch(url, { signal, headers: { accept } });
    if (!response.ok) throw new SandboxdDownloadError(`Download failed (${response.status}) for ${url}`);
    return (await response.text()).trim();
  });

// List the entries of a `.tar.gz` without extracting, so we can reject archives
// that contain anything other than the expected single binary (path traversal,
// symlinks, extra entries) before touching the filesystem.
const listTarGz = (archivePath: string): Promise<string[]> =>
  new Promise((res, rej) => {
    const child = spawn("tar", ["-tzf", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rej);
    child.on("close", (code) =>
      code === 0
        ? res(stdout.split("\n").map((line) => line.trim()).filter(Boolean))
        : rej(new SandboxdDownloadError(`tar listing failed: ${stderr.trim() || `exit ${code}`}`)),
    );
  });

// Extract a single-file `.tar.gz` using the system tar (universally present on
// macOS and Linux), keeping the CLI free of native archive dependencies.
const extractTarGz = (archivePath: string, cwd: string): Promise<void> =>
  new Promise((res, rej) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", cwd], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rej);
    child.on("close", (code) =>
      code === 0 ? res() : rej(new SandboxdDownloadError(`tar extraction failed: ${stderr.trim() || `exit ${code}`}`)),
    );
  });

// Cross-process lock via atomic mkdir, mirroring the CLI self-update lock so two
// concurrent `sandbox up` invocations don't download the same archive twice.
const withLock = async <T>(version: string, fn: () => Promise<T>): Promise<T> => {
  const lockPath = join(cacheDir(version), ".download.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new SandboxdDownloadError("Timed out waiting for the sandboxd download lock");
};

const downloadAndVerify = async (version: string, target: Target): Promise<string> => {
  const name = archiveName(version, target);
  const archiveUrl = `${cdnBaseUrl()}/${version}/${name}`;
  const checksumUrl = `${archiveUrl}.sha256`;

  const tempDir = await mkdtemp(join(tmpdir(), "cohub-sandboxd-"));
  try {
    const archivePath = join(tempDir, name);

    // Fetch archive to disk (timeout covers the full body stream).
    await downloadToFile(archiveUrl, "application/gzip", archivePath);

    // Fetch and verify checksum. The .sha256 file is `<hash>  <filename>`.
    const checksumText = await fetchText(checksumUrl, "text/plain");
    const expected = checksumText.split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new SandboxdDownloadError(`Invalid checksum manifest for ${name}`);
    }
    const actual = (await sha256File(archivePath)).toLowerCase();
    if (actual !== expected) {
      throw new SandboxdDownloadError(`Checksum mismatch for ${name} (expected ${expected}, got ${actual})`);
    }

    // Verify the archive contains exactly the expected binary before extracting,
    // guarding against path traversal / unexpected entries from a tampered CDN.
    const entries = await listTarGz(archivePath);
    if (entries.length !== 1 || entries[0] !== BINARY_NAME) {
      throw new SandboxdDownloadError(`Unexpected archive contents for ${name}: ${entries.join(", ") || "(empty)"}`);
    }

    // Extract the single binary from the archive.
    await extractTarGz(archivePath, tempDir);
    const extractedBinary = join(tempDir, BINARY_NAME);
    if (!(await isExecutableFile(extractedBinary))) {
      throw new SandboxdDownloadError(`Archive ${name} did not contain ${BINARY_NAME}`);
    }

    // Atomically move into the version cache (fall back to copy across devices).
    const dest = cachedBinaryPath(version);
    await mkdir(dirname(dest), { recursive: true });
    await rename(extractedBinary, dest).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(extractedBinary, dest);
    });
    await chmod(dest, 0o755);
    return dest;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

export type EnsureSandboxdOptions = {
  version?: string;
  onStatus?: (message: string) => void;
};

// Resolve a runnable sandboxd binary path, downloading (once, cached) if needed.
// COHUB_SANDBOXD_BIN always takes precedence for local development and offline use.
export const ensureSandboxdBinary = async (options: EnsureSandboxdOptions = {}): Promise<string> => {
  const override = process.env.COHUB_SANDBOXD_BIN?.trim();
  if (override) {
    if (!(await isExecutableFile(override))) {
      throw new SandboxdDownloadError(`COHUB_SANDBOXD_BIN=${override} is not a file`);
    }
    return override;
  }

  const version = options.version?.trim() || SANDBOXD_VERSION;
  const cached = cachedBinaryPath(version);
  if (await isExecutableFile(cached)) return cached;

  const target = resolveTarget();
  return withLock(version, async () => {
    // Re-check inside the lock: another process may have finished downloading.
    if (await isExecutableFile(cached)) return cached;
    options.onStatus?.(`Downloading sandbox runtime ${version} (${target.goos}/${target.goarch})`);
    const path = await downloadAndVerify(version, target);
    options.onStatus?.("Sandbox runtime ready");
    return path;
  });
};
