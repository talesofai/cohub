import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerationAdapterInput, GenerationContentBlock } from "@neta-art/generation";
import { klingVideoGenerationsAdapter } from "../src/generations/kling-video-adapter.js";

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
};

function createInput(input: {
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}) {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
    });

    if (requests.length === 1) {
      return new Response(JSON.stringify({ data: { task_id: "task-1" } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        status: "completed",
        progress: 100,
        metadata: { url: "https://example.com/output.mp4" },
      }),
      { status: 200 },
    );
  };

  const parameters = { poll_interval: 0, ...(input.parameters ?? {}) };
  return {
    requests,
    adapterInput: {
      declaration: {
        schema: "neta.generation.model.v1",
        model: input.model,
        adapter: { type: "kling.videoGenerations" },
        content: {
          input: [
            { type: "text", required: false, merge: "newline" },
            { type: "image", required: false, max: 2, sources: ["url"] },
          ],
        },
      },
      request: {
        model: input.model,
        content: input.content,
        parameters,
        meta: input.meta,
      },
      parameters,
      meta: input.meta ?? {},
      context: {
        apiKey: "sk-test",
        baseUrl: "https://router.example",
        fetch,
        resolveSource: (source) => {
          if (source.type === "url") return source.url;
          return `data:${source.mediaType};base64,${source.data}`;
        },
      },
    } satisfies GenerationAdapterInput,
  };
}

function textBlock(text: string): GenerationContentBlock {
  return { type: "text", text };
}

function imageBlock(url: string, meta?: Record<string, unknown>): GenerationContentBlock {
  return {
    type: "image",
    source: { type: "url", url },
    ...(meta ? { meta } : {}),
  };
}

test("posts latest Kling text-to-video payload", async () => {
  const { adapterInput, requests } = createInput({
    model: "kling-text-to-video",
    content: [textBlock("paper boat on calm water")],
    parameters: {
      duration: 10,
      aspect_ratio: "9:16",
      mode: "pro",
      cfg_scale: 0.7,
      negative_prompt: "blurry",
    },
    meta: { cohub: { taskRunId: "internal" } },
  });

  const output = await klingVideoGenerationsAdapter(adapterInput);

  assert.equal(requests[0]?.url, "https://router.example/kling/v1/videos/text2video");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer sk-test");
  assert.equal(requests[1]?.url, "https://router.example/kling/v1/videos/text2video/task-1");
  assert.deepEqual(requests[0]?.body, {
    model_name: "kling-v3",
    prompt: "paper boat on calm water",
    duration: "10",
    mode: "pro",
    cfg_scale: 0.7,
    aspect_ratio: "9:16",
    negative_prompt: "blurry",
  });
  assert.deepEqual(output, [
    {
      type: "video",
      source: { type: "url", url: "https://example.com/output.mp4" },
      meta: { task_id: "task-1", status: "succeeded", progress: 100 },
    },
  ]);
});

test("posts latest Kling image-to-video payload", async () => {
  const { adapterInput, requests } = createInput({
    model: "kling-image-to-video",
    content: [
      textBlock("gently turn toward the camera"),
      imageBlock("https://example.com/first.png"),
      imageBlock("https://example.com/last.png"),
    ],
  });

  await klingVideoGenerationsAdapter(adapterInput);

  assert.equal(requests[0]?.url, "https://router.example/kling/v1/videos/image2video");
  assert.deepEqual(requests[0]?.body, {
    model_name: "kling-v3",
    prompt: "gently turn toward the camera",
    duration: "5",
    mode: "std",
    cfg_scale: 0.5,
    aspect_ratio: "16:9",
    image: "https://example.com/first.png",
    image_tail: "https://example.com/last.png",
  });
});

test("posts latest Kling Omni-Video payload", async () => {
  const { adapterInput, requests } = createInput({
    model: "kling-omni-video",
    content: [
      textBlock("<<<image_1>>> moves toward <<<image_2>>>"),
      imageBlock("https://example.com/first.png", { role: "first_frame" }),
      imageBlock("https://example.com/last.png", { role: "last_frame" }),
    ],
    parameters: { sound: "on" },
  });

  await klingVideoGenerationsAdapter(adapterInput);

  assert.equal(requests[0]?.url, "https://router.example/kling/v1/videos/omni-video");
  assert.equal(requests[0]?.body?.image, undefined);
  assert.deepEqual(requests[0]?.body, {
    model_name: "kling-v3-omni",
    prompt: "<<<image_1>>> moves toward <<<image_2>>>",
    duration: "5",
    mode: "std",
    cfg_scale: 0.5,
    aspect_ratio: "16:9",
    sound: "on",
    image_list: [
      { image_url: "https://example.com/first.png", type: "first_frame" },
      { image_url: "https://example.com/last.png", type: "end_frame" },
    ],
  });
});

test("preserves official Omni media meta arrays", async () => {
  const imageList = [{ image_url: "https://example.com/ref.png", type: "first_frame" }];
  const elementList = [{ element_id: "subject" }];
  const { adapterInput, requests } = createInput({
    model: "kling-omni-video",
    content: [textBlock("<<<image_1>>> cinematic motion"), imageBlock("https://example.com/ignored.png")],
    meta: {
      image_list: imageList,
      element_list: elementList,
      cohub: { taskRunId: "internal" },
    },
  });

  await klingVideoGenerationsAdapter(adapterInput);

  assert.equal(requests[0]?.body?.image, undefined);
  assert.deepEqual(requests[0]?.body, {
    model_name: "kling-v3-omni",
    prompt: "<<<image_1>>> cinematic motion",
    image_list: imageList,
    element_list: elementList,
    duration: "5",
    mode: "std",
    cfg_scale: 0.5,
    aspect_ratio: "16:9",
  });
});

test("posts latest Kling multi-image reference video payload", async () => {
  const { adapterInput, requests } = createInput({
    model: "kling-multi-image-to-video",
    content: [
      textBlock("combine the references into one cinematic shot"),
      imageBlock("https://example.com/ref-1.png"),
      imageBlock("https://example.com/ref-2.png"),
    ],
  });

  await klingVideoGenerationsAdapter(adapterInput);

  assert.equal(requests[0]?.url, "https://router.example/kling/v1/videos/multi-image2video");
  assert.deepEqual(requests[0]?.body, {
    model_name: "kling-v1-6",
    prompt: "combine the references into one cinematic shot",
    duration: "5",
    mode: "std",
    cfg_scale: 0.5,
    aspect_ratio: "16:9",
    image_list: [
      { image: "https://example.com/ref-1.png" },
      { image: "https://example.com/ref-2.png" },
    ],
  });
});
