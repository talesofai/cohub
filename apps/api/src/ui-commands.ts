import { randomUUID } from "node:crypto";
import {
  UI_COMMAND_VERSION,
  type UiCommand,
  type UiCommandError,
  type UiCommandRecord,
  type UiCommandStatus,
} from "@cohub/protocol/ui-command";
import type { RequestSource } from "@cohub/protocol/provenance";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";
import { redisCommandClient } from "./redis.js";
import {
  claimUiCommand,
  readUiCommand,
  settleUiCommandRecord,
  type UiCommandSettleOutcome,
  type UiCommandStoreClient,
} from "./ui-commands.store.js";

const store = () => redisCommandClient as unknown as UiCommandStoreClient;

async function dispatch(record: UiCommandRecord): Promise<void> {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "ui",
    type: "ui.command.dispatched",
    spaceId: record.source?.spaceId ?? null,
    sessionId: record.source?.sessionId ?? null,
    rooms: [getRealtimeUserRoom(record.actorUserId)],
    payload: {
      commandId: record.commandId,
      targetClientId: record.targetClientId,
      command: record.command,
      source: record.source,
    },
  });
}

export async function getUiCommand(commandId: string): Promise<UiCommandRecord | null> {
  return readUiCommand(store(), commandId);
}

export class UiCommandOwnershipError extends Error {
  constructor() {
    super("ui command belongs to another user");
    this.name = "UiCommandOwnershipError";
  }
}

export async function createUiCommand(input: {
  commandId?: string | null;
  actorUserId: string;
  command: UiCommand;
  targetClientId: string | null;
  source: RequestSource | null;
}): Promise<{ record: UiCommandRecord; reused: boolean }> {
  const commandId = input.commandId?.trim() || randomUUID();
  const now = new Date().toISOString();
  const settledWithoutTarget = !input.targetClientId;
  const record: UiCommandRecord = {
    version: UI_COMMAND_VERSION,
    commandId,
    status: settledWithoutTarget ? "no_active_client" : "pending",
    command: input.command,
    actorUserId: input.actorUserId,
    targetClientId: input.targetClientId ?? "",
    source: input.source,
    error: settledWithoutTarget
      ? {
          code: "no_active_client",
          message:
            "No Cohub frontend instance is bound to this request. Run from a chat started in the Cohub app, or pass an explicit client id.",
        }
      : null,
    createdAt: now,
    settledAt: settledWithoutTarget ? now : null,
  };

  const claim = await claimUiCommand(store(), record);
  if (!claim.claimed) {
    const existing = claim.record;
    if (existing.actorUserId !== input.actorUserId) throw new UiCommandOwnershipError();
    // Delivery is best-effort, so a retry publishes again; the frontend dedupes.
    if (!existing.settledAt && existing.targetClientId) {
      await dispatch(existing);
    }
    return { record: existing, reused: true };
  }

  if (!settledWithoutTarget) await dispatch(record);
  return { record: claim.record, reused: false };
}

export async function settleUiCommand(input: {
  commandId: string;
  actorUserId: string;
  reportingClientId: string | null;
  status: UiCommandStatus;
  result?: unknown;
  error?: UiCommandError | null;
}): Promise<UiCommandSettleOutcome> {
  return settleUiCommandRecord(store(), {
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reportingClientId: input.reportingClientId,
    next: (current) => ({
      ...current,
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
      error: input.error ?? null,
      settledAt: new Date().toISOString(),
    }),
  });
}
