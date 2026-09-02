import { randomUUID } from "node:crypto";
import type {
  BoardComposition,
  BoardEffect,
  BoardMutationReceipt,
  BoardPlaybackSnapshot,
  RequestSource,
} from "@cohub/protocol";
import { dispatchRealtimeEvent } from "./channels.js";

export async function dispatchBoardChanged(input: {
  spaceId: string;
  boardId: string;
  actorId: string;
  mutationId: string;
  version: number;
  changed: BoardMutationReceipt["changed"];
  source?: RequestSource | null;
  animationPatch?: {
    effects: BoardEffect[];
    compositions: BoardComposition[];
    playback?: BoardPlaybackSnapshot | null;
  };
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.changed",
    spaceId: input.spaceId,
    sessionId: null,
    payload: {
      boardId: input.boardId,
      actorId: input.actorId,
      mutationId: input.mutationId,
      version: input.version,
      changed: input.changed,
      ...(input.animationPatch ? { animationPatch: input.animationPatch } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
  });
}

export async function dispatchBoardPlaybackChanged(input: {
  spaceId: string;
  snapshot: BoardPlaybackSnapshot;
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.playback.changed",
    spaceId: input.spaceId,
    sessionId: null,
    payload: input.snapshot,
  });
}
