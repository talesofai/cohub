import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenerationTaskRequestSchema } from "./schema.js";

const baseRequest = {
  spaceId: "00000000-0000-4000-8000-000000000001",
  model: "MiniMax-H3",
  content: [{ type: "text" as const, text: "A continuous transition" }],
};

const image = (name: string) => ({ type: "url" as const, url: `https://example.com/${name}.png` });

test("generation schema accepts fixed timeline keyframes", () => {
  const result = createGenerationTaskRequestSchema.safeParse({
    ...baseRequest,
    timeline: {
      keyframes: [
        { timeSec: 0, source: image("start") },
        { timeSec: 5, source: image("end") },
      ],
    },
  });
  assert.equal(result.success, true);
});

test("generation schema rejects timeline intervals shorter than H3 minimum", () => {
  const result = createGenerationTaskRequestSchema.safeParse({
    ...baseRequest,
    timeline: {
      keyframes: [
        { timeSec: 0, source: image("start") },
        { timeSec: 3, source: image("end") },
      ],
    },
  });
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.issues[0]?.message ?? "", /at least 4 seconds/);
});

test("generation schema rejects non-http timeline URLs without throwing", () => {
  const result = createGenerationTaskRequestSchema.safeParse({
    ...baseRequest,
    timeline: {
      keyframes: [{ timeSec: 5, source: { type: "url", url: "ftp://example.com/end.png" } }],
    },
  });
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.issues.at(-1)?.message ?? "", /http or https/);
});

test("generation schema rejects non-image timeline base64 sources", () => {
  const result = createGenerationTaskRequestSchema.safeParse({
    ...baseRequest,
    timeline: {
      keyframes: [{ timeSec: 5, source: { type: "base64", mediaType: "video/mp4", data: "AAAA" } }],
    },
  });
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.issues.at(-1)?.message ?? "", /image sources/);
});
