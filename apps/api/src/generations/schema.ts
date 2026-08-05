import { z } from "zod";
import {
  GENERATION_TIMELINE_MAX_BASE64_CHARS,
  GENERATION_TIMELINE_MAX_DURATION_SEC,
  GENERATION_TIMELINE_MAX_KEYFRAMES,
  GENERATION_TIMELINE_MAX_KEYFRAME_BASE64_CHARS,
  GENERATION_TIMELINE_MIN_INTERVAL_SEC,
} from "@cohub/protocol/generation";

const metaSchema = z.record(z.string(), z.unknown());

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const generationSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string().url() }),
  z.object({
    type: z.literal("base64"),
    mediaType: z.string().min(1),
    data: z.string().min(1).max(GENERATION_TIMELINE_MAX_KEYFRAME_BASE64_CHARS),
  }),
]);

const generationTimelineKeyframeSchema = z.object({
  timeSec: z.number().int().min(0).max(GENERATION_TIMELINE_MAX_DURATION_SEC),
  source: generationSourceSchema.superRefine((source, context) => {
    if (source.type === "url" && !isHttpUrl(source.url)) {
      context.addIssue({ code: "custom", message: "Timeline image URLs must use http or https" });
    }
    if (source.type === "base64" && !source.mediaType.toLowerCase().startsWith("image/")) {
      context.addIssue({ code: "custom", message: "Timeline keyframes must use image sources" });
    }
  }),
});

const generationTimelineSchema = z.object({
  keyframes: z.array(generationTimelineKeyframeSchema).min(1).max(GENERATION_TIMELINE_MAX_KEYFRAMES),
}).superRefine((timeline, context) => {
  let previousTime = -1;
  for (const [index, keyframe] of timeline.keyframes.entries()) {
    if (keyframe.timeSec <= previousTime) {
      context.addIssue({
        code: "custom",
        path: ["keyframes", index, "timeSec"],
        message: "Timeline keyframe times must be strictly increasing",
      });
    }
    previousTime = keyframe.timeSec;
  }
  const totalBase64Chars = timeline.keyframes.reduce(
    (total, keyframe) => total + (keyframe.source.type === "base64" ? keyframe.source.data.length : 0),
    0,
  );
  if (totalBase64Chars > GENERATION_TIMELINE_MAX_BASE64_CHARS) {
    context.addIssue({
      code: "custom",
      path: ["keyframes"],
      message: `Timeline base64 image data cannot exceed ${GENERATION_TIMELINE_MAX_BASE64_CHARS} characters in total`,
    });
  }
  let intervalStart = 0;
  for (const [index, keyframe] of timeline.keyframes.entries()) {
    if (keyframe.timeSec !== intervalStart && keyframe.timeSec - intervalStart < GENERATION_TIMELINE_MIN_INTERVAL_SEC) {
      context.addIssue({
        code: "custom",
        path: ["keyframes", index, "timeSec"],
        message: "Timeline intervals must be at least 4 seconds",
      });
    }
    intervalStart = keyframe.timeSec;
  }
  if (timeline.keyframes.length > 0 && timeline.keyframes.at(-1)?.timeSec === 0) {
    context.addIssue({
      code: "custom",
      path: ["keyframes"],
      message: "Timeline must contain at least one second of video",
    });
  }
});

export const generationContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), meta: metaSchema.optional() }),
  z.object({ type: z.literal("image"), source: generationSourceSchema, meta: metaSchema.optional() }),
  z.object({ type: z.literal("video"), source: generationSourceSchema, meta: metaSchema.optional() }),
  z.object({ type: z.literal("audio"), source: generationSourceSchema, meta: metaSchema.optional() }),
]);

export const createGenerationTaskRequestSchema = z.object({
  spaceId: z.string().uuid(),
  sessionId: z.string().uuid().optional().nullable(),
  turnId: z.string().uuid().optional().nullable(),
  model: z.string().min(1),
  content: z.array(generationContentBlockSchema).min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  timeline: generationTimelineSchema.optional(),
});

export type CreateGenerationTaskRequestInput = z.infer<typeof createGenerationTaskRequestSchema>;
