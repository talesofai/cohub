import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { spawn } from "node:child_process";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GenerationProviderError,
  GenerationValidationError,
  type GenerationContentBlock,
  type GenerationModelDeclaration,
  type GenerationResult,
  type GenerationSource,
} from "@neta-art/generation";
import {
  GENERATION_TIMELINE_MAX_DURATION_SEC,
  GENERATION_TIMELINE_MAX_BASE64_CHARS,
  GENERATION_TIMELINE_MAX_KEYFRAMES,
  GENERATION_TIMELINE_MAX_KEYFRAME_BASE64_CHARS,
  GENERATION_TIMELINE_MIN_INTERVAL_SEC,
  type GenerationTimelineKeyframe,
  type GenerationTimelineRequest,
  type GenerationTimelineResult,
} from "@cohub/protocol/generation";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const MIN_SEGMENT_DURATION_SEC = GENERATION_TIMELINE_MIN_INTERVAL_SEC;
const MAX_SEGMENT_DURATION_SEC = 15;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_TIMELINE_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
const TEMPORARY_OBJECT_CACHE_CONTROL = "no-store";
const TEMPORARY_OBJECT_TAGGING = "cohub_timeline_temporary=true";

type TimelineSegmentPlan = {
  startSec: number;
  endSec: number;
  durationSec: number;
  startSource?: GenerationSource;
  endSource?: GenerationSource;
};

export type TimelineGenerationResult = GenerationResult & { timeline: GenerationTimelineResult };

/** Carries provider spend out of a failed multi-segment orchestration. */
export class TimelineGenerationError extends Error {
  readonly originalError: unknown;
  readonly cost: number;
  readonly requestIds: string[];

  constructor(originalError: unknown, cost: number, requestIds: readonly string[] = []) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "TimelineGenerationError";
    this.originalError = originalError;
    this.cost = cost;
    this.requestIds = [...requestIds];
  }
}

type TimelineGenerate = (input: {
  content: GenerationContentBlock[];
  parameters: Record<string, unknown>;
}) => Promise<GenerationResult>;

export type GenerateTimelineInput = {
  declaration: GenerationModelDeclaration;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  timeline: unknown;
  spaceId: string;
  taskRunId: string;
  generate: TimelineGenerate;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGenerationSource(value: unknown): value is GenerationSource {
  if (!isRecord(value) || (value.type !== "url" && value.type !== "base64")) return false;
  if (value.type === "url") {
    if (typeof value.url !== "string" || value.url.trim().length === 0) return false;
    try {
      const protocol = new URL(value.url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }
  return (
    typeof value.mediaType === "string" &&
    value.mediaType.toLowerCase().startsWith("image/") &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    value.data.length <= GENERATION_TIMELINE_MAX_KEYFRAME_BASE64_CHARS
  );
}

/** Validate queued timeline data again because task payloads are untrusted. */
export function parseGenerationTimeline(value: unknown): GenerationTimelineRequest {
  if (!isRecord(value) || !Array.isArray(value.keyframes)) {
    throw new GenerationValidationError("Generation timeline keyframes are required");
  }
  if (value.keyframes.length < 1 || value.keyframes.length > GENERATION_TIMELINE_MAX_KEYFRAMES) {
    throw new GenerationValidationError(
      `Generation timeline must contain between 1 and ${GENERATION_TIMELINE_MAX_KEYFRAMES} keyframes`,
    );
  }

  const keyframes: GenerationTimelineKeyframe[] = [];
  let totalBase64Chars = 0;
  let previousTime = -1;
  for (const [index, rawKeyframe] of value.keyframes.entries()) {
    if (!isRecord(rawKeyframe)) {
      throw new GenerationValidationError(`Generation timeline keyframe ${index + 1} must be an object`);
    }
    const timeSec = rawKeyframe.timeSec;
    if (typeof timeSec !== "number" || !Number.isSafeInteger(timeSec) || timeSec < 0) {
      throw new GenerationValidationError(`Generation timeline keyframe ${index + 1} timeSec must be a non-negative integer`);
    }
    if (timeSec <= previousTime) {
      throw new GenerationValidationError("Generation timeline keyframe times must be strictly increasing");
    }
    if (!isGenerationSource(rawKeyframe.source)) {
      throw new GenerationValidationError(`Generation timeline keyframe ${index + 1} must contain an image source`);
    }
    if (rawKeyframe.source.type === "base64") {
      totalBase64Chars += rawKeyframe.source.data.length;
      if (totalBase64Chars > GENERATION_TIMELINE_MAX_BASE64_CHARS) {
        throw new GenerationValidationError(
          `Generation timeline base64 image data cannot exceed ${GENERATION_TIMELINE_MAX_BASE64_CHARS} characters in total`,
        );
      }
    }
    keyframes.push({ timeSec, source: rawKeyframe.source });
    previousTime = timeSec;
  }

  const durationSec = keyframes.at(-1)?.timeSec ?? 0;
  if (durationSec <= 0) throw new GenerationValidationError("Generation timeline must contain at least one second of video");
  if (durationSec > GENERATION_TIMELINE_MAX_DURATION_SEC) {
    throw new GenerationValidationError(
      `Generation timeline duration cannot exceed ${GENERATION_TIMELINE_MAX_DURATION_SEC} seconds`,
    );
  }
  return { keyframes };
}

/** Split a whole-second interval into H3-compatible 4-15 second chunks. */
export function partitionTimelineDuration(durationSec: number): number[] {
  if (!Number.isSafeInteger(durationSec) || durationSec < MIN_SEGMENT_DURATION_SEC) {
    throw new GenerationValidationError("Generation timeline intervals must be at least 4 seconds");
  }
  const partCount = Math.ceil(durationSec / MAX_SEGMENT_DURATION_SEC);
  const base = Math.floor(durationSec / partCount);
  const remainder = durationSec % partCount;
  const parts = Array.from({ length: partCount }, (_, index) => base + (index < remainder ? 1 : 0));
  if (parts.some((part) => part < MIN_SEGMENT_DURATION_SEC || part > MAX_SEGMENT_DURATION_SEC)) {
    throw new GenerationValidationError("Generation timeline interval cannot be represented by 4-15 second H3 segments");
  }
  return parts;
}

export function planGenerationTimeline(value: unknown): TimelineSegmentPlan[] {
  const timeline = parseGenerationTimeline(value);
  const plan: TimelineSegmentPlan[] = [];
  let previousTime = 0;
  let previousSource: GenerationSource | undefined;

  for (const keyframe of timeline.keyframes) {
    if (keyframe.timeSec === previousTime) {
      previousSource = keyframe.source;
      continue;
    }
    const durations = partitionTimelineDuration(keyframe.timeSec - previousTime);
    let startSec = previousTime;
    for (const [index, durationSec] of durations.entries()) {
      const endSec = startSec + durationSec;
      plan.push({
        startSec,
        endSec,
        durationSec,
        ...(index === 0 && previousSource ? { startSource: previousSource } : {}),
        ...(index === durations.length - 1 ? { endSource: keyframe.source } : {}),
      });
      startSec = endSec;
    }
    previousTime = keyframe.timeSec;
    previousSource = keyframe.source;
  }
  return plan;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, FFMPEG_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2_000);
      reject(new Error(`ffmpeg failed with exit code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function extractLastFrame(videoPath: string, framePath: string): Promise<void> {
  // Decode the final second in reverse so the first emitted frame is the
  // actual final frame, independent of the video's frame rate.
  await runFfmpeg([
    "-sseof",
    "-1",
    "-i",
    videoPath,
    "-vf",
    "reverse",
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-y",
    framePath,
  ]);
  const data = await readFile(framePath);
  if (data.length === 0) throw new Error("ffmpeg produced an empty timeline frame");
}

function isPrivateIp(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  if (version !== 4) return false;
  const octets = normalized.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first === 0
  );
}

function assertSafeProviderUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GenerationProviderError("Timeline provider returned an invalid video URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateIp(parsed.hostname)) {
    throw new GenerationProviderError("Timeline provider returned an unsafe video URL", {
      details: { protocol: parsed.protocol, hostname: parsed.hostname },
    });
  }
  return parsed;
}

async function downloadVideo(source: GenerationSource, targetPath: string): Promise<number> {
  if (source.type === "base64") {
    const data = Buffer.from(source.data, "base64");
    if (data.length > MAX_VIDEO_BYTES) throw new Error("Generated timeline segment is too large");
    await writeFile(targetPath, data);
    return data.length;
  }
  const parsed = assertSafeProviderUrl(source.url);
  let response: Response;
  try {
    response = await fetch(parsed, {
      redirect: "manual",
      signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GenerationProviderError("Failed to download generated timeline segment", {
      details: { hostname: parsed.hostname, reason: error instanceof Error ? error.message : String(error) },
    });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GenerationProviderError("Generated timeline segment URL redirects and was rejected", {
      status: response.status,
      details: { hostname: parsed.hostname, hasLocation: response.headers.has("location") },
    });
  }
  if (!response.ok || !response.body) {
    throw new GenerationProviderError("Failed to download generated timeline segment", {
      status: response.status,
      details: { hostname: parsed.hostname },
    });
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_VIDEO_BYTES) throw new Error("Generated timeline segment is too large");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes <= MAX_VIDEO_BYTES ? null : new Error("Generated timeline segment is too large"), chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), limiter, createWriteStream(targetPath));
  return bytes;
}

async function concatVideos(videoPaths: string[], outputPath: string, workDir: string): Promise<void> {
  const listPath = join(workDir, "concat.txt");
  const list = videoPaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n");
  await writeFile(listPath, `${list}\n`, "utf8");
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);
}

let storageClient: S3Client | null = null;

function getStorageClient(): S3Client {
  if (!config.turnObjectS3Bucket || !config.turnObjectS3Endpoint) {
    throw new Error("TURN_OBJECT_S3_BUCKET and TURN_OBJECT_S3_ENDPOINT are required for timeline output");
  }
  if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
    throw new Error("TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for timeline output");
  }
  storageClient ??= new S3Client({
    endpoint: config.turnObjectS3Endpoint,
    region: config.turnObjectS3Region,
    forcePathStyle: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.turnObjectS3AccessKeyId,
      secretAccessKey: config.turnObjectS3SecretAccessKey,
    },
  });
  return storageClient;
}

function timelineObjectKey(input: { spaceId: string; taskRunId: string; fileName: string }): string {
  const safeSpaceId = input.spaceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const safeTaskRunId = input.taskRunId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const safeFileName = input.fileName.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const envPrefix = config.env === "dev" ? "dev/" : "";
  return `${envPrefix}spaces/${safeSpaceId}/generations/${safeTaskRunId}/${safeFileName}`;
}

function timelineObjectUrl(objectKey: string): string {
  return `${config.turnObjectCdnBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadTimelineObject(input: {
  filePath: string;
  objectKey: string;
  contentType: string;
  cacheControl?: string;
  temporary?: boolean;
}): Promise<void> {
  const file = await stat(input.filePath);
  if (!file.isFile()) throw new Error("Timeline output must be a regular file");
  await getStorageClient().send(new PutObjectCommand({
    Bucket: config.turnObjectS3Bucket,
    Key: input.objectKey,
    Body: createReadStream(input.filePath),
    ContentLength: file.size,
    ContentType: input.contentType,
    CacheControl: input.cacheControl ?? TEMPORARY_OBJECT_CACHE_CONTROL,
    ...(input.temporary === false ? {} : { Tagging: TEMPORARY_OBJECT_TAGGING }),
  }));
}

async function deleteTimelineObjects(objectKeys: ReadonlySet<string>): Promise<void> {
  if (!storageClient || !config.turnObjectS3Bucket || objectKeys.size === 0) return;
  let pendingKeys = [...objectKeys];
  for (let attempt = 1; attempt <= 2 && pendingKeys.length > 0; attempt += 1) {
    const results = await Promise.allSettled(
      pendingKeys.map((Key) => storageClient?.send(new DeleteObjectCommand({
        Bucket: config.turnObjectS3Bucket,
        Key,
      }))),
    );
    pendingKeys = pendingKeys.filter((_, index) => results[index]?.status === "rejected");
  }
  if (pendingKeys.length > 0) {
    logger.warn("[GenerationTimeline] failed to delete temporary objects", {
      bucket: config.turnObjectS3Bucket,
      keys: pendingKeys,
    });
  }
}

async function uploadTimelineVideo(input: { filePath: string; spaceId: string; taskRunId: string }): Promise<string> {
  const objectKey = timelineObjectKey({ ...input, fileName: "timeline.mp4" });
  await uploadTimelineObject({
    filePath: input.filePath,
    objectKey,
    contentType: "video/mp4",
    cacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
    temporary: false,
  });
  return timelineObjectUrl(objectKey);
}

async function uploadTimelineFrame(input: { filePath: string; spaceId: string; taskRunId: string; index: number }): Promise<{ objectKey: string; url: string }> {
  const objectKey = timelineObjectKey({
    spaceId: input.spaceId,
    taskRunId: input.taskRunId,
    fileName: `frame-${String(input.index).padStart(2, "0")}.png`,
  });
  await uploadTimelineObject({ filePath: input.filePath, objectKey, contentType: "image/png", temporary: true });
  return { objectKey, url: timelineObjectUrl(objectKey) };
}

async function materializeTimelineSources(input: {
  timeline: GenerationTimelineRequest;
  workDir: string;
  spaceId: string;
  taskRunId: string;
  uploadedObjectKeys: Set<string>;
}): Promise<GenerationTimelineRequest> {
  const keyframes: GenerationTimelineKeyframe[] = [];
  for (const [index, keyframe] of input.timeline.keyframes.entries()) {
    if (keyframe.source.type === "url") {
      keyframes.push(keyframe);
      continue;
    }

    const data = Buffer.from(keyframe.source.data, "base64");
    if (data.length === 0) {
      throw new GenerationValidationError(`Generation timeline keyframe ${index + 1} contains invalid image data`);
    }
    const filePath = join(input.workDir, `keyframe-${String(index + 1).padStart(2, "0")}.bin`);
    await writeFile(filePath, data);
    const objectKey = timelineObjectKey({
      spaceId: input.spaceId,
      taskRunId: input.taskRunId,
      fileName: `keyframe-${String(index + 1).padStart(2, "0")}.bin`,
    });
    await uploadTimelineObject({ filePath, objectKey, contentType: keyframe.source.mediaType, temporary: true });
    input.uploadedObjectKeys.add(objectKey);
    keyframes.push({
      timeSec: keyframe.timeSec,
      source: { type: "url", url: timelineObjectUrl(objectKey) },
    });
  }
  return { keyframes };
}

function textOnlyContent(content: GenerationContentBlock[]): GenerationContentBlock[] {
  const text = content.filter((block) => block.type === "text");
  if (text.length === 0) throw new GenerationValidationError("Timeline generation requires a text prompt");
  if (text.length !== content.length) {
    throw new GenerationValidationError("Timeline generation cannot mix keyframes with reference media");
  }
  return text;
}

function addRequestId(requestIds: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) requestIds.add(value.trim());
}

function collectBlockRequestIds(requestIds: Set<string>, block: GenerationContentBlock): void {
  if (!block.meta || !isRecord(block.meta)) return;
  addRequestId(requestIds, block.meta.request_id);
  addRequestId(requestIds, block.meta.requestId);
  addRequestId(requestIds, block.meta.task_id);
  addRequestId(requestIds, block.meta.taskId);
}

type ProviderObservation = {
  cost?: number;
  requestIds: string[];
};

function observeProviderFailure(error: unknown): ProviderObservation {
  const result: ProviderObservation = { requestIds: [] };
  const requestIds = new Set<string>();
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "cost" && result.cost === undefined && typeof child === "number" && Number.isFinite(child) && child > 0) {
        result.cost = child;
      }
      if (normalizedKey === "request_id" || normalizedKey === "requestid" || normalizedKey === "task_id" || normalizedKey === "taskid") {
        addRequestId(requestIds, child);
      }
      visit(child, depth + 1);
    }
  };

  if (error instanceof GenerationProviderError) visit(error.details, 0);
  result.requestIds = [...requestIds];
  return result;
}

export async function generateTimeline(input: GenerateTimelineInput): Promise<TimelineGenerationResult> {
  if (input.declaration.adapter.type !== "minimax.h3VideoGenerations") {
    throw new GenerationValidationError("Timeline generation currently requires the MiniMax H3 video model");
  }
  const timeline = parseGenerationTimeline(input.timeline);
  const content = textOnlyContent(input.content);
  if (!config.turnObjectCdnBaseUrl) throw new Error("TURN_OBJECT_CDN_BASE_URL is required for timeline output");
  getStorageClient();
  const workDir = await mkdtemp(join(tmpdir(), "cohub-generation-timeline-"));
  const videoPaths: string[] = [];
  const requestIds = new Set<string>();
  const uploadedObjectKeys = new Set<string>();
  let totalCost = 0;
  let totalVideoBytes = 0;
  let generatedFrame: GenerationSource | undefined;

  try {
    const normalizedTimeline = await materializeTimelineSources({
      timeline,
      workDir,
      spaceId: input.spaceId,
      taskRunId: input.taskRunId,
      uploadedObjectKeys,
    });
    const plan = planGenerationTimeline(normalizedTimeline);
    for (const [index, segment] of plan.entries()) {
      const segmentContent: GenerationContentBlock[] = [...content];
      const startSource = segment.startSource ?? generatedFrame;
      if (startSource) segmentContent.push({ type: "image", source: startSource, meta: { role: "first_frame" } });
      if (segment.endSource) segmentContent.push({ type: "image", source: segment.endSource, meta: { role: "last_frame" } });

      let result: GenerationResult;
      try {
        result = await input.generate({
          content: segmentContent,
          parameters: { ...(input.parameters ?? {}), duration: segment.durationSec },
        });
      } catch (error) {
        const observation = observeProviderFailure(error);
        if (observation.cost !== undefined) totalCost += observation.cost;
        for (const requestId of observation.requestIds) requestIds.add(requestId);
        throw error;
      }
      addRequestId(requestIds, result.requestId);
      if (typeof result.cost === "number" && Number.isFinite(result.cost) && result.cost > 0) totalCost += result.cost;
      const video = result.content.find((block) => block.type === "video");
      if (!video) throw new GenerationProviderError("Timeline segment generation returned no video");
      collectBlockRequestIds(requestIds, video);
      const videoPath = join(workDir, `segment-${String(index + 1).padStart(2, "0")}.mp4`);
      totalVideoBytes += await downloadVideo(video.source, videoPath);
      if (totalVideoBytes > MAX_TIMELINE_VIDEO_BYTES) {
        throw new GenerationProviderError("Generated timeline segments exceed the total size limit", {
          details: { maxBytes: MAX_TIMELINE_VIDEO_BYTES },
        });
      }
      videoPaths.push(videoPath);

      const nextSegment = plan[index + 1];
      if (nextSegment && !nextSegment.startSource) {
        const framePath = join(workDir, `frame-${String(index + 1).padStart(2, "0")}.png`);
        await extractLastFrame(videoPath, framePath);
        const frame = await uploadTimelineFrame({
          filePath: framePath,
          spaceId: input.spaceId,
          taskRunId: input.taskRunId,
          index: index + 1,
        });
        uploadedObjectKeys.add(frame.objectKey);
        generatedFrame = { type: "url", url: frame.url };
      } else {
        generatedFrame = undefined;
      }
    }

    const outputPath = join(workDir, "timeline.mp4");
    await concatVideos(videoPaths, outputPath, workDir);
    const output = await stat(outputPath);
    if (output.size > MAX_TIMELINE_VIDEO_BYTES) {
      throw new GenerationProviderError("Generated timeline output exceeds the total size limit", {
        details: { maxBytes: MAX_TIMELINE_VIDEO_BYTES, size: output.size },
      });
    }
    const url = await uploadTimelineVideo({ filePath: outputPath, spaceId: input.spaceId, taskRunId: input.taskRunId });
    return {
      content: [{ type: "video", source: { type: "url", url }, meta: { timeline: true, duration_sec: plan.at(-1)?.endSec ?? 0 } }],
      ...(totalCost > 0 ? { cost: totalCost } : {}),
      timeline: {
        durationSec: plan.at(-1)?.endSec ?? 0,
        segmentCount: plan.length,
        requestIds: [...requestIds],
        url,
      },
    };
  } catch (error) {
    if (totalCost > 0) throw new TimelineGenerationError(error, totalCost, [...requestIds]);
    throw error;
  } finally {
    await deleteTimelineObjects(uploadedObjectKeys);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
