import { randomUUID } from "node:crypto";
import type { BoardOperation, BoardPlaybackSnapshot } from "@cohub/protocol";
import { getRealtimeBoardRoom, getRealtimeBoardSpaceRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";

export async function dispatchBoardTransactionApplied(input: {
  spaceId: string;
  boardId: string;
  actorId: string;
  txId: string;
  version: number;
  operations: BoardOperation[];
  metadata: Record<string, unknown>;
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.transaction.applied",
    spaceId: input.spaceId,
    sessionId: null,
    rooms: [getRealtimeBoardRoom(input.boardId), getRealtimeBoardSpaceRoom(input.spaceId)],
    payload: {
      boardId: input.boardId,
      actorId: input.actorId,
      txId: input.txId,
      version: input.version,
      operations: input.operations,
      metadata: input.metadata,
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
    rooms: [getRealtimeBoardRoom(input.snapshot.boardId), getRealtimeBoardSpaceRoom(input.spaceId)],
    payload: input.snapshot,
  });
}
