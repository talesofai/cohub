import { randomUUID } from "node:crypto";
import type { CanvasTransactionAppliedEvent } from "@cohub/protocol/realtime";

export function createCanvasTransactionAppliedEvent(input: {
  spaceId: string;
  documentId: string;
  actorId: string;
  txId: string;
  version: number;
  ops: Array<Record<string, unknown>>;
  occurredAt: Date;
}): CanvasTransactionAppliedEvent {
  return {
    id: randomUUID(),
    timestamp: input.occurredAt.getTime(),
    domain: "space",
    type: "canvas.tx.applied",
    spaceId: input.spaceId,
    sessionId: null,
    payload: {
      documentId: input.documentId,
      actorId: input.actorId,
      txId: input.txId,
      version: input.version,
      ops: input.ops,
    },
  };
}
