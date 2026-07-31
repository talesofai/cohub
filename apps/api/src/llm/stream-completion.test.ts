import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreRemoteImageUrls } from "./stream-completion.js";

const URL_IMAGE_MIME = "application/x-cohub-image-url";
const sampleUrl = "https://public.cohub.run/spaces/x/chat/a.webp";
const encoded = Buffer.from(sampleUrl, "utf8").toString("base64");

test("restoreRemoteImageUrls rewrites OpenAI image_url objects", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${URL_IMAGE_MIME};base64,${encoded}` },
          },
        ],
      },
    ],
  };
  const restored = restoreRemoteImageUrls(payload) as typeof payload;
  assert.deepEqual(restored.messages[0]?.content[0], {
    type: "image_url",
    image_url: { url: sampleUrl },
  });
});

test("restoreRemoteImageUrls rewrites Anthropic base64 image sources", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: URL_IMAGE_MIME,
              data: encoded,
            },
          },
        ],
      },
    ],
  };
  const restored = restoreRemoteImageUrls(payload) as typeof payload;
  assert.deepEqual(restored.messages[0]?.content[0], {
    type: "image",
    source: { type: "url", url: sampleUrl },
  });
});

test("restoreRemoteImageUrls leaves real base64 images untouched", () => {
  const payload = {
    type: "image_url",
    image_url: { url: "data:image/webp;base64,AAAA" },
  };
  assert.deepEqual(restoreRemoteImageUrls(payload), payload);
});

test("restoreRemoteImageUrls preserves nested AbortSignal instances", () => {
  const signal = new AbortController().signal;
  const payload = { config: { abortSignal: signal } };
  const restored = restoreRemoteImageUrls(payload) as typeof payload;

  assert.equal(restored.config.abortSignal, signal);
  assert.equal(typeof restored.config.abortSignal.addEventListener, "function");
});
