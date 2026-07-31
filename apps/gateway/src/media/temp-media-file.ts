import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob, type PathLike } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform, type Transform as TransformStream } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type TempMediaFile = {
  path: string;
  size: number;
  cleanup: () => Promise<void>;
};

const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60 * 1000;

class ByteLimitTransform extends Transform {
  #total = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly label: string,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.#total += chunk.length;
    if (this.#total > this.maxBytes) {
      callback(new Error(`${this.label} exceeds ${this.maxBytes} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

async function createTempTarget(label: string) {
  const dir = await mkdtemp(join(tmpdir(), "cohub-gateway-media-"));
  return {
    dir,
    path: join(dir, basename(label).replace(/[^a-zA-Z0-9._-]/g, "_") || "media"),
  };
}

async function tempFileResult(dir: string, path: string): Promise<TempMediaFile> {
  const info = await stat(path);
  return {
    path,
    size: info.size,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function responseToTempMediaFile(
  response: Response,
  maxBytes: number,
  label: string,
  options?: { timeoutMs?: number },
) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  if (!response.body) throw new Error(`${label} response body is missing`);

  const target = await createTempTarget(label);
  const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = new Error(`${label} body timed out after ${timeoutMs}ms`);
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort(timeoutError);
        source.destroy(timeoutError);
      }, timeoutMs)
    : null;
  timer?.unref();
  try {
    await pipeline(
      source,
      new ByteLimitTransform(maxBytes, label),
      createWriteStream(target.path, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal },
    );
    return await tempFileResult(target.dir, target.path);
  } catch (error) {
    await rm(target.dir, { recursive: true, force: true });
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function base64ToTempMediaFile(data: string, maxBytes: number, label: string) {
  const target = await createTempTarget(label);
  const handle = await open(target.path, "wx", 0o600);
  const chunkChars = 1024 * 1024;
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4 + 4;
  let encodedChars = 0;
  let carry = "";
  let size = 0;
  try {
    for (let offset = 0; offset < data.length; offset += chunkChars) {
      const end = Math.min(data.length, offset + chunkChars);
      const cleaned = data.slice(offset, end).replace(/\s/g, "");
      encodedChars += cleaned.length;
      if (encodedChars > maxEncodedChars) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      const normalized = carry + cleaned;
      const readyChars = end === data.length ? normalized.length : normalized.length - (normalized.length % 4);
      carry = normalized.slice(readyChars);
      if (readyChars === 0) continue;
      const chunk = Buffer.from(normalized.slice(0, readyChars), "base64");
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      await handle.write(chunk);
    }
    if (carry) {
      const chunk = Buffer.from(carry, "base64");
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      await handle.write(chunk);
    }
    await handle.close();
    return await tempFileResult(target.dir, target.path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target.dir, { recursive: true, force: true });
    throw error;
  }
}

export async function transformTempMediaFile(
  source: TempMediaFile,
  transform: TransformStream,
  maxBytes: number,
  label: string,
) {
  const target = await createTempTarget(label);
  try {
    await pipeline(
      createReadStream(source.path),
      transform,
      new ByteLimitTransform(maxBytes, label),
      createWriteStream(target.path, { flags: "wx", mode: 0o600 }),
    );
    return await tempFileResult(target.dir, target.path);
  } catch (error) {
    await rm(target.dir, { recursive: true, force: true });
    throw error;
  }
}

export async function hashTempMediaFile(file: TempMediaFile, algorithm: "md5" | "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file.path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readTempMediaHead(file: TempMediaFile, maxBytes: number) {
  const handle = await open(file.path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(file.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const tempMediaBlob = (file: TempMediaFile | { path: PathLike }, type = "application/octet-stream") =>
  openAsBlob(file.path, { type });
