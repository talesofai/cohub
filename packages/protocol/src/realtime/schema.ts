import { z } from "zod";
import type { ContentBlock } from "../core/content.js";
import type { RealtimeCompactFrame, RealtimeEnvelope, RealtimeRoom } from "./types.js";
import { REALTIME_ROOM_EVENT_NAME_PATTERN } from "./types.js";
import { BoardAwarenessClientPayloadSchema } from "./board-awareness.js";
export type * from "./types.js";

const contentBlockMetaSchema = z.record(z.string(), z.unknown());
const realtimeRoomSchema = z.string().regex(/^(space|user|board|room):[^:]+$/);

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().optional(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("image"),
    source: z.union([
      z.object({ type: z.literal("url"), url: z.string().url() }),
      z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    ]),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("shell_command"),
    command: z.string(),
    rawText: z.string(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
    is_error: z.boolean().optional(),
    _meta: contentBlockMetaSchema.optional(),
  }),
  z.object({
    type: z.literal("system_note"),
    note_type: z.enum(["session_created", "forked", "compacted", "info"]),
    text: z.string(),
    _meta: contentBlockMetaSchema.optional(),
  }),
]) as z.ZodType<ContentBlock>;

export const wsClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    requestId: z.string().optional(),
    payload: z.object({
      token: z.string().min(1),
      capabilities: z.array(z.string().min(1)).optional(),
    }),
  }),
  z.object({
    type: z.literal("subscribe"),
    requestId: z.string().optional(),
    payload: z.object({
      rooms: z.array(realtimeRoomSchema).min(1),
    }),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    requestId: z.string().optional(),
    payload: z.object({
      rooms: z.array(realtimeRoomSchema).min(1),
    }),
  }),
  z.object({
    type: z.literal("session.message.create"),
    requestId: z.string().optional(),
    payload: z.object({
      spaceId: z.string().uuid(),
      sessionId: z.string().uuid(),
      clientMessageId: z.string().optional(),
      content: z.array(contentBlockSchema).min(1),
      model: z.string().optional(),
      provider: z.string().optional(),
      thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("presence.update"),
    requestId: z.string().optional(),
    payload: z.object({
      spaceId: z.string().uuid(),
      meta: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("board.awareness.update"),
    requestId: z.string().optional(),
    payload: BoardAwarenessClientPayloadSchema,
  }),
  z.object({
    type: z.literal("realtime.room.join"),
    requestId: z.string().optional(),
    payload: z.object({ roomId: z.string().uuid(), ticket: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("realtime.room.publish"),
    requestId: z.string().optional(),
    payload: z.object({
      roomId: z.string().uuid(),
      event: z.string().regex(REALTIME_ROOM_EVENT_NAME_PATTERN),
      data: z.unknown(),
      clientEventId: z.string().max(128).optional(),
    }),
  }),
  z.object({
    type: z.literal("realtime.room.leave"),
    requestId: z.string().optional(),
    payload: z.object({ roomId: z.string().uuid() }),
  }),
  z.object({
    type: z.literal("realtime.room.presence.update"),
    requestId: z.string().optional(),
    payload: z.object({
      roomId: z.string().uuid(),
      presence: z.record(z.string(), z.unknown()).nullable(),
    }),
  }),
  z.object({
    type: z.literal("ping"),
    requestId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("ack"),
    requestId: z.string().optional(),
    payload: z.object({ eventId: z.string().optional() }).optional(),
  }),
]);

export const realtimeEnvelopeSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  domain: z.enum(["system", "session", "space", "label", "room", "ui"]),
  type: z.string(),
  requestId: z.string().nullable().optional(),
  spaceId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  rooms: z.array(realtimeRoomSchema).optional() as z.ZodType<RealtimeRoom[] | undefined>,
  payload: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<RealtimeEnvelope>;

export const channelEnvelopeSchema = realtimeEnvelopeSchema;

export const realtimeCompactFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("d"),
    sid: z.string().min(1),
    s: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    v: z.unknown(),
  }),
  z.object({
    t: z.literal("p"),
    sid: z.string().min(1),
    s: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    o: z.enum(["append", "replace", "add", "merge", "remove"]),
    p: z.string().min(1),
    v: z.unknown().optional(),
  }),
]) satisfies z.ZodType<RealtimeCompactFrame>;
