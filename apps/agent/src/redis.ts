import { Redis } from "ioredis";
import { z } from "zod";
import type { ContentBlock, SpaceSandboxStatus } from "@cohub/protocol";
import { env } from "./env.js";

const redis = new Redis(env.REDIS_URL);
const subClient = redis.duplicate();

const spacePrefix = `spaces:${env.SPACE_ID}`;
const LIST_KEY_IN = `${spacePrefix}:input_queue`;
const PROCESSING_KEY = `${spacePrefix}:processing_queue`;
const DEAD_LETTER_KEY = `${spacePrefix}:dead_letter_queue`;
const STREAM_KEY_OUT = `${spacePrefix}:output_stream`;
const META_KEY = `${spacePrefix}:meta`;

const PromptInputSchema = z.object({
  action: z.literal("prompt"),
  spaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  userMessageId: z.string().uuid().nullable().optional(),
  content: z.array(z.unknown()).min(1),
  meta: z
    .object({
      source: z.string().optional(),
      interactionId: z.string().optional(),
      actorUserId: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const AbortInputSchema = z.object({
  action: z.literal("abort"),
  spaceId: z.string().uuid(),
  sessionId: z.string().uuid().nullable().optional(),
});

export const InputSchema = z.union([PromptInputSchema, AbortInputSchema]);
export type AgentInput = z.infer<typeof InputSchema>;

/**
 * Extract plain text from a list of ContentBlocks.
 */
export function extractContentText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && "text" in b)
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Extract image blocks from ContentBlock[] in the format expected by the SDK.
 */
export function extractContentImages(blocks: ContentBlock[]): Array<{ type: "image"; data: string; mimeType: string }> {
  const results: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const b of blocks) {
    if (b.type !== "image") continue;
    const img = b as { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } };
    if (img.source.type !== "base64") continue;
    results.push({ type: "image", data: img.source.data, mimeType: img.source.media_type });
  }
  return results;
}

export async function reportSandboxStatus(
  status: SpaceSandboxStatus,
) {
  const internalApiBaseUrl = env.ENV === "prod"
    ? "http://cohub-api.cohub.svc.cluster.local:8787"
    : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787";
  const url = `${internalApiBaseUrl}/internal/spaces/${env.SPACE_ID}/status`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  }).catch((err) => {
    console.error("[Redis] Failed to report sandbox status via internal API:", err);
  });
}

const STREAM_MAXLEN = 10000;
const STREAM_APPROX = "~";

export async function sendOutput(data: unknown) {
  try {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    await redis.xadd(STREAM_KEY_OUT, "MAXLEN", STREAM_APPROX, STREAM_MAXLEN, "*", "payload", payload);
  } catch (err) {
    console.error("[Redis] Failed to send output:", err);
  }
}

async function moveToDeadLetterQueue(rawMessage: string, reason: string) {
  try {
    await redis.rpush(
      DEAD_LETTER_KEY,
      JSON.stringify({ rawMessage, reason, failedAt: new Date().toISOString() }),
    );
  } catch (error) {
    console.error("[Redis] Failed to push message to dead letter queue:", error);
  }
}

export async function listenForInput(
  handler: (
    input: AgentInput,
    ack: () => Promise<void>,
    reject: (reason: string) => Promise<void>,
  ) => void,
) {
  console.log(`[Redis] Listening for input on ${LIST_KEY_IN}...`);
  while (true) {
    let rawMessage: string | null = null;

    try {
      rawMessage = await subClient.brpoplpush(LIST_KEY_IN, PROCESSING_KEY, 0);
      if (!rawMessage) continue;

      const parsed = InputSchema.parse(JSON.parse(rawMessage));
      const currentRawMessage = rawMessage;
      let handled = false;

      const ack = async () => {
        if (handled) return;
        handled = true;
        await redis.lrem(PROCESSING_KEY, 1, currentRawMessage).catch((e) => {
          console.error("[Redis] Failed to ack message:", e);
        });
      };

      const reject = async (reason: string) => {
        if (handled) return;
        handled = true;
        try {
          await moveToDeadLetterQueue(currentRawMessage, reason);
          await redis.lrem(PROCESSING_KEY, 1, currentRawMessage);
        } catch (e) {
          console.error("[Redis] Failed to reject message:", e);
        }
      };

      try {
        // Fire and forget - handler manages its own ack/reject
        handler(parsed, ack, reject);
      } catch (syncErr) {
        console.error("[Redis] Sync error in handler:", syncErr);
        await reject(syncErr instanceof Error ? syncErr.message : String(syncErr));
      }
    } catch (err) {
      console.error("[Redis] Error processing input:", err);

      if (rawMessage) {
        const reason = err instanceof Error ? err.message : String(err);
        await moveToDeadLetterQueue(rawMessage, reason);
        await redis.lrem(PROCESSING_KEY, 1, rawMessage).catch(() => {});
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function closeRedisConnections() {
  await Promise.allSettled([subClient.quit(), redis.quit()]);
}
