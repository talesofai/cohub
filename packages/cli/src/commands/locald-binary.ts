import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// Bump only after the matching locald release has reached the public CDN.
export const LOCALD_VERSION = "v1.0.0";
const BINARY_NAME = "cohub-locald";
const CDN_BASE_URL = (): string =>
  (process.env.COHUB_LOCALD_CDN_BASE_URL?.trim() || "https://public.cohub.run/locald").replace(/\/+$/, "");
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const GOOS_BY_PLATFORM: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const GOARCH_BY_ARCH: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
};

type Target = { goos: string; goarch: string; binaryName: string };

export class LocaldUnavailableError extends Error {
  override name = "LocaldUnavailableError";
}

export class LocaldDownloadError extends LocaldUnavailableError {
  override name = "LocaldDownloadError";
}

const resolveTarget = (): Target => {
  const goos = GOOS_BY_PLATFORM[process.platform];
  const goarch = GOARCH_BY_ARCH[process.arch];
  if (!goos || !goarch) {
    throw new LocaldDownloadError(
      `Unsupported platform ${process.platform}/${process.arch}. Set COHUB_LOCALD_BIN to a locally built binary.`,
    );
  }
  return { goos, goarch, binaryName: process.platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME };
};

const cacheDir = (version: string) => join(homedir(), ".cache", "cohub", "locald", version);
export const localdBinaryCachePath = (version: string = LOCALD_VERSION) => join(cacheDir(version), resolveTarget().binaryName);
const archiveName = (version: string, target: Target) => `${BINARY_NAME}_${version}_${target.goos}_${target.goarch}.tar.gz`;

const isExecutableFile = async (path: string) => {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  if (process.platform === "win32") return true;
  return access(path, constants.X_OK).then(() => true).catch(() => false);
};

const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

const withTimeout = async <T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (cause) {
    if (cause instanceof LocaldDownloadError) throw cause;
    if (controller.signal.aborted) throw new LocaldDownloadError(`${what} timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    throw new LocaldDownloadError(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    clearTimeout(timer);
  }
};

const downloadToFile = (url: string, destination: string) => withTimeout(`Download of ${url}`, async (signal) => {
  const response = await fetch(url, { signal, headers: { accept: "application/gzip" } });
  if (!response.ok) throw new LocaldDownloadError(`Download failed (${response.status}) for ${url}`);
  if (!response.body) throw new LocaldDownloadError(`Empty response body for ${url}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ARCHIVE_BYTES) throw new LocaldDownloadError(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination, { flags: "wx" }),
  );
  const downloaded = await stat(destination);
  if (downloaded.size > MAX_ARCHIVE_BYTES) throw new LocaldDownloadError(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
});

const fetchText = (url: string) => withTimeout(`Download of ${url}`, async (signal) => {
  const response = await fetch(url, { signal, headers: { accept: "text/plain" } });
  if (!response.ok) throw new LocaldDownloadError(`Download failed (${response.status}) for ${url}`);
  return (await response.text()).trim();
});

const listTarGz = (archivePath: string): Promise<string[]> => new Promise((resolvePromise, reject) => {
  const child = spawn("tar", ["-tzf", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("close", (code) => code === 0
    ? resolvePromise(stdout.split("\n").map((line) => line.trim()).filter(Boolean))
    : reject(new LocaldDownloadError(`tar listing failed: ${stderr.trim() || `exit ${code}`}`)));
});

const extractTarGz = (archivePath: string, destination: string): Promise<void> => new Promise((resolvePromise, reject) => {
  const child = spawn("tar", ["-xzf", archivePath, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("close", (code) => code === 0
    ? resolvePromise()
    : reject(new LocaldDownloadError(`tar extraction failed: ${stderr.trim() || `exit ${code}`}`)));
});

const withLock = async <T>(version: string, fn: () => Promise<T>): Promise<T> => {
  const lockPath = join(cacheDir(version), ".download.lock");
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new LocaldDownloadError("Timed out waiting for the locald download lock");
};

const downloadAndVerify = async (version: string, target: Target): Promise<string> => {
  const name = archiveName(version, target);
  const archiveUrl = `${CDN_BASE_URL()}/${version}/${name}`;
  const checksumUrl = `${archiveUrl}.sha256`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cohub-locald-"));
  try {
    const archivePath = join(temporaryDirectory, name);
    await downloadToFile(archiveUrl, archivePath);
    const checksumText = await fetchText(checksumUrl);
    const expected = checksumText.split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new LocaldDownloadError(`Invalid checksum manifest for ${name}`);
    const actual = (await sha256File(archivePath)).toLowerCase();
    if (actual !== expected) throw new LocaldDownloadError(`Checksum mismatch for ${name}`);

    const entries = await listTarGz(archivePath);
    const allowed = new Set([target.binaryName, "LICENSE", "NOTICE"]);
    if (!entries.includes(target.binaryName) || entries.some((entry) => !allowed.has(entry)) || entries.length !== allowed.size) {
      throw new LocaldDownloadError(`Unexpected archive contents for ${name}: ${entries.join(", ") || "(empty)"}`);
    }
    await extractTarGz(archivePath, temporaryDirectory);
    const extracted = join(temporaryDirectory, target.binaryName);
    if (!(await isExecutableFile(extracted))) throw new LocaldDownloadError(`Archive ${name} did not contain ${target.binaryName}`);

    const destination = join(cacheDir(version), target.binaryName);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(extracted, destination).catch(async (cause) => {
      if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
      await copyFile(extracted, destination);
    });
    await chmod(destination, 0o755);
    return destination;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

export type EnsureLocaldOptions = {
  version?: string;
  force?: boolean;
  onStatus?: (message: string) => void;
};

export const ensureLocaldBinary = async (options: EnsureLocaldOptions = {}): Promise<string> => {
  const override = process.env.COHUB_LOCALD_BIN?.trim();
  if (override) {
    if (!(await isExecutableFile(override))) throw new LocaldUnavailableError(`COHUB_LOCALD_BIN=${override} is not an executable file`);
    return override;
  }
  const version = options.version?.trim() || process.env.COHUB_LOCALD_VERSION?.trim() || LOCALD_VERSION;
  const target = resolveTarget();
  const cached = join(cacheDir(version), target.binaryName);
  if (!options.force && await isExecutableFile(cached)) return cached;
  return withLock(version, async () => {
    if (!options.force && await isExecutableFile(cached)) return cached;
    options.onStatus?.(`Downloading local agent runtime ${version} (${target.goos}/${target.goarch})`);
    const path = await downloadAndVerify(version, target);
    options.onStatus?.("Local agent runtime ready");
    return path;
  });
};

export const installLocaldBinary = (options: EnsureLocaldOptions = {}) => ensureLocaldBinary(options);
export const updateLocaldBinary = (options: Omit<EnsureLocaldOptions, "force"> = {}) => ensureLocaldBinary({ ...options, force: true });

export async function resolveLocaldBinary(options: { download?: boolean } = {}): Promise<string> {
  const override = process.env.COHUB_LOCALD_BIN?.trim();
  if (override) {
    if (!(await isExecutableFile(override))) throw new LocaldUnavailableError(`COHUB_LOCALD_BIN=${override} is not an executable file`);
    return override;
  }
  const command = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(command, [BINARY_NAME], { stdio: ["ignore", "pipe", "pipe"] });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolvePromise(Buffer.concat(output).toString("utf8")) : reject(new Error(`exit ${code}`)));
    });
    const path = result.trim().split(/\r?\n/)[0];
    if (path && await isExecutableFile(path)) return path;
  } catch {
    // The versioned cache is the next local source; downloading is explicit
    // only when the caller permits it.
  }
  const cached = join(cacheDir(process.env.COHUB_LOCALD_VERSION?.trim() || LOCALD_VERSION), resolveTarget().binaryName);
  if (await isExecutableFile(cached)) return cached;
  if (options.download === false) {
    throw new LocaldUnavailableError(
      "cohub-locald is not installed. Run `cohub agent runtime install` or set COHUB_LOCALD_BIN to its path.",
    );
  }
  return ensureLocaldBinary();
}
