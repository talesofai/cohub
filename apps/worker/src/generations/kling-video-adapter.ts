import {
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
  mergeTextBlocks,
  type GenerationAdapterInput,
  type GenerationContentBlock,
} from "@neta-art/generation";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_MAX_WAIT_SEC = 900;

type KlingImageMode = "none" | "single" | "omni" | "multi";

const KLING_MODELS: Record<
  string,
  {
    submitPath: string;
    defaultModelName: string;
    imageMode: KlingImageMode;
    allowMultiShotWithoutPrompt?: boolean;
  }
> = {
  "kling-text-to-video": {
    submitPath: "/kling/v1/videos/text2video",
    defaultModelName: "kling-v3",
    imageMode: "none",
  },
  "kling-image-to-video": {
    submitPath: "/kling/v1/videos/image2video",
    defaultModelName: "kling-v3",
    imageMode: "single",
  },
  "kling-omni-video": {
    submitPath: "/kling/v1/videos/omni-video",
    defaultModelName: "kling-v3-omni",
    imageMode: "omni",
    allowMultiShotWithoutPrompt: true,
  },
  "kling-multi-image-to-video": {
    submitPath: "/kling/v1/videos/multi-image2video",
    defaultModelName: "kling-v1-6",
    imageMode: "multi",
  },
};

type CreateTaskResponse = {
  id?: unknown;
  task_id?: unknown;
  status?: unknown;
  data?: {
    id?: unknown;
    task_id?: unknown;
    status?: unknown;
    task_status?: unknown;
  };
};

type TaskStatusResponse = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  task_status?: unknown;
  video_url?: unknown;
  result_url?: unknown;
  url?: unknown;
  progress?: unknown;
  error?: {
    message?: unknown;
  };
  metadata?: {
    url?: unknown;
  };
  data?: {
    status?: unknown;
    task_status?: unknown;
    task_status_msg?: unknown;
    result_url?: unknown;
    video_url?: unknown;
    url?: unknown;
    progress?: unknown;
    task_result?: {
      videos?: Array<{ url?: unknown; duration?: unknown }>;
    };
    data?: {
      status?: unknown;
      content?: { video_url?: unknown; first_frame?: unknown };
      progress?: unknown;
      task_result?: {
        videos?: Array<{ url?: unknown; duration?: unknown }>;
      };
    };
  };
};

type ResolvedImage = {
  url: string;
  role?: string;
};

type OmniImageReference = {
  image_url: string;
  type?: string;
};

type MultiImageReference = {
  image: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function providerMeta(input: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...input };
  delete rest.cohub;
  return rest;
}

function normalizeStatus(value: unknown): string {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "success" || status === "succeed" || status === "succeeded" || status === "completed") {
    return "succeeded";
  }
  if (status === "queued" || status === "processing" || status === "in_progress" || status === "not_start" || status === "submitted") {
    return "processing";
  }
  if (status === "failure" || status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return status || "unknown";
}

function resolveAspectRatio(parameters: Record<string, unknown>): string {
  const size = asString(parameters.size);
  if (size === "720x1280" || size === "1080x1920") return "9:16";
  if (size === "1024x1024" || size === "512x512") return "1:1";
  const aspectRatio = asString(parameters.aspect_ratio);
  return aspectRatio ?? "16:9";
}

function getImageRole(block: Extract<GenerationContentBlock, { type: "image" }>): string | undefined {
  const role = block.meta?.role;
  return typeof role === "string" && role.trim() ? role.trim() : undefined;
}

async function resolveImages(input: GenerationAdapterInput): Promise<ResolvedImage[]> {
  const imageBlocks = input.request.content.filter(
    (block): block is Extract<GenerationContentBlock, { type: "image" }> => block.type === "image",
  );
  return Promise.all(
    imageBlocks.map(async (block) => ({
      url: await input.context.resolveSource(block.source),
      role: getImageRole(block),
    })),
  );
}

function hasOfficialOmniMedia(meta: Record<string, unknown>): boolean {
  return ["image_list", "element_list", "video_list"].some((key) => meta[key] !== undefined);
}

function hasPlainImagePayload(meta: Record<string, unknown>): boolean {
  return typeof meta.image === "string";
}

function hasMultiImagePayload(meta: Record<string, unknown>): boolean {
  return Array.isArray(meta.image_list);
}

function isMultiShotPayload(meta: Record<string, unknown>): boolean {
  const value = meta.multi_shot;
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

function omniImageType(image: ResolvedImage, index: number): string | undefined {
  if (image.role === "first_frame" || image.role === "end_frame") return image.role;
  if (image.role === "last_frame") return "end_frame";
  if (!image.role) return index === 0 ? "first_frame" : "end_frame";
  return undefined;
}

function buildOmniImageList(images: ResolvedImage[]): OmniImageReference[] {
  return images.map((image, index) => {
    const type = omniImageType(image, index);
    return type ? { image_url: image.url, type } : { image_url: image.url };
  });
}

function buildMultiImageList(images: ResolvedImage[]): MultiImageReference[] {
  return images.map((image) => ({ image: image.url }));
}

function resolveKlingModel(input: GenerationAdapterInput) {
  const model = KLING_MODELS[input.declaration.model];
  if (!model) throw new GenerationValidationError(`Unsupported Kling generation model: ${input.declaration.model}`);
  return model;
}

function buildPayload(
  input: GenerationAdapterInput,
  model: (typeof KLING_MODELS)[string],
  prompt: string,
  images: ResolvedImage[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...providerMeta(input.meta),
    model_name: model.defaultModelName,
    prompt,
  };

  if (!payload.model_name) payload.model_name = model.defaultModelName;
  if (!payload.duration) payload.duration = String(asInteger(input.parameters.duration, 5));
  if (!payload.mode) payload.mode = asString(input.parameters.mode) ?? "std";
  if (payload.cfg_scale === undefined) payload.cfg_scale = asNumber(input.parameters.cfg_scale) ?? 0.5;
  if (!payload.aspect_ratio) payload.aspect_ratio = resolveAspectRatio(input.parameters);
  if (payload.camera_control === undefined && isRecord(input.parameters.camera_control)) {
    payload.camera_control = input.parameters.camera_control;
  }
  if (payload.negative_prompt === undefined && asString(input.parameters.negative_prompt)) {
    payload.negative_prompt = input.parameters.negative_prompt;
  }
  if (payload.sound === undefined && asString(input.parameters.sound)) payload.sound = input.parameters.sound;
  if (payload.watermark_info === undefined && isRecord(input.parameters.watermark_info)) {
    payload.watermark_info = input.parameters.watermark_info;
  }
  if (payload.multi_shot === undefined && asBoolean(input.parameters.multi_shot) !== undefined) {
    payload.multi_shot = input.parameters.multi_shot;
  }

  if (model.imageMode === "single" && images[0] && !hasPlainImagePayload(payload)) {
    payload.image = images[0].url;
    if (images[1] && payload.image_tail === undefined) payload.image_tail = images[1].url;
  }
  if (model.imageMode === "omni" && images.length > 0 && !hasOfficialOmniMedia(payload) && !hasPlainImagePayload(payload)) {
    payload.image_list = buildOmniImageList(images);
  }
  if (model.imageMode === "multi" && images.length > 0 && !hasMultiImagePayload(payload)) {
    payload.image_list = buildMultiImageList(images);
  }
  if (payload.seed === undefined && input.parameters.seed !== undefined) payload.seed = input.parameters.seed;

  return payload;
}

function extractTaskId(response: CreateTaskResponse): string {
  const taskId = asString(response.task_id) ?? asString(response.id) ?? asString(response.data?.task_id) ?? asString(response.data?.id);
  if (!taskId) {
    throw new GenerationProviderError("Kling video provider did not return a task id", { details: { response } });
  }
  return taskId;
}

function extractStatus(response: TaskStatusResponse) {
  const wrapper = response.data;
  const native = wrapper?.data;
  const status = normalizeStatus(native?.status ?? wrapper?.task_status ?? wrapper?.status ?? response.task_status ?? response.status);
  const firstVideo = wrapper?.task_result?.videos?.[0] ?? native?.task_result?.videos?.[0];
  const videoUrl =
    asString(firstVideo?.url) ??
    asString(wrapper?.result_url) ??
    asString(wrapper?.video_url) ??
    asString(wrapper?.url) ??
    asString(native?.content?.video_url) ??
    asString(response.metadata?.url) ??
    asString(response.result_url) ??
    asString(response.video_url) ??
    asString(response.url);
  const message = asString(wrapper?.task_status_msg) ?? asString(response.error?.message) ?? asString(response.message);
  return {
    status,
    videoUrl,
    message,
    metadata: compactObject({
      progress: wrapper?.progress ?? native?.progress ?? response.progress,
      duration: firstVideo?.duration,
      task_status_msg: message,
      code: response.code,
    }),
  };
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await input.context.fetch(`${input.context.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.text();
    let parsed: unknown = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      throw new GenerationProviderError("Kling video provider returned invalid JSON", { status: response.status, body });
    }
    if (!response.ok) {
      throw new GenerationProviderError("Kling video provider request failed", {
        status: response.status,
        body,
        details: isRecord(parsed) ? parsed : undefined,
      });
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function klingVideoGenerationsAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const model = resolveKlingModel(input);
  const prompt = mergeTextBlocks(input.declaration, input.request.content);
  const images = await resolveImages(input);
  const meta = providerMeta(input.meta);
  if (!prompt && !model.allowMultiShotWithoutPrompt) {
    throw new GenerationValidationError("Prompt text is required");
  }
  if (!prompt && model.allowMultiShotWithoutPrompt && !hasPlainImagePayload(meta) && !isMultiShotPayload(meta)) {
    throw new GenerationValidationError("Prompt text is required for Kling Omni unless multi_shot meta is provided");
  }
  if (model.imageMode === "single" && images.length === 0 && !hasPlainImagePayload(meta)) {
    throw new GenerationValidationError("Image input is required");
  }
  if (model.imageMode === "multi" && images.length === 0 && !hasMultiImagePayload(meta)) {
    throw new GenerationValidationError("Multi-image input is required");
  }

  const task = (await requestJson(input, model.submitPath, {
    method: "POST",
    body: JSON.stringify(buildPayload(input, model, prompt, images)),
  })) as CreateTaskResponse;
  const taskId = extractTaskId(task);
  const pollIntervalSec = asInteger(input.parameters.poll_interval, DEFAULT_POLL_INTERVAL_SEC);
  const maxWaitSec = asInteger(input.parameters.max_wait, DEFAULT_MAX_WAIT_SEC);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= maxWaitSec * 1000) {
    await sleep(pollIntervalSec * 1000);
    const rawStatus = (await requestJson(input, `${model.submitPath}/${encodeURIComponent(taskId)}`, {
      method: "GET",
    })) as TaskStatusResponse;
    const status = extractStatus(rawStatus);

    if (status.status === "succeeded") {
      if (!status.videoUrl) {
        throw new GenerationProviderError("Kling video generation succeeded but returned no video URL", {
          details: { taskId, rawStatus, metadata: status.metadata },
        });
      }
      return [
        {
          type: "video",
          source: { type: "url", url: status.videoUrl },
          meta: { task_id: taskId, status: status.status, ...status.metadata },
        },
      ];
    }
    if (status.status === "failed" || status.status === "cancelled" || status.status === "expired") {
      throw new GenerationProviderError(`Kling video generation ${status.status}`, {
        details: { taskId, message: status.message, rawStatus },
      });
    }
  }

  throw new GenerationTimeoutError("Timed out waiting for Kling video generation", { taskId });
}
