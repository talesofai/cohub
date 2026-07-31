import { createLogger } from "@cohub/infra/logging";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MessageRecord, SessionTurnRecord } from "@cohub/protocol/model";
import type { GatewaySessionOutput } from "@cohub/protocol/gateway";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import {
  dispatchOutboundMessage,
  dispatchRealtimeEvent,
  getProviderMessageRefBySessionMessage,
  getBindingsBySessionId,
} from "./channels.js";
import { dispatchSpaceDomainEvent } from "./space-events.js";
import { db } from "./db/index.js";
import { spaceChannels } from "@cohub/db";
import { clearSessionStreamSnapshot } from "./session-stream-snapshot.js";
import { toRealtimeMessageRecord, toRealtimeTurnRecord } from "./realtime-events.js";
import { getIdentityKeys, resolveStoredPrincipalUser } from "./identity-bridge.js";


const logger = createLogger({ serviceName: "cohub-api" });
export const buildSessionOutputsForPersistedMessage = async (input: {
  spaceId: string;
  sessionId: string;
  message: MessageRecord;
}): Promise<GatewaySessionOutput[]> => {
  const outputs: GatewaySessionOutput[] = [{
    type: "session.message.persisted",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    message: input.message,
  }];

  if (input.message.meta?.messageKind === "assistant_error" && input.message.stopReason !== "aborted") {
    outputs.push({
      type: "session.turn.error",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      anchorUserMessageId: typeof input.message.meta?.anchorUserMessageId === "string"
        ? (input.message.meta.anchorUserMessageId as string)
        : null,
      error: input.message.errorMessage ?? "assistant error",
    });
  }

  return outputs;
};

const shouldClearStreamSnapshotForMessage = (message: MessageRecord) => {
  const kind = message.meta?.messageKind;
  return kind === "assistant_final" || kind === "assistant_error" || message.stopReason === "aborted";
};

const dispatchSessionOutputToRealtime = async (output: GatewaySessionOutput) => {
  if (output.type === "session.turn.error") {
    await clearSessionStreamSnapshot({ spaceId: output.spaceId, sessionId: output.sessionId });
    await dispatchRealtimeEvent({
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "session",
      type: output.type,
      spaceId: output.spaceId,
      sessionId: output.sessionId,
      payload: {
        anchorUserMessageId: output.anchorUserMessageId,
        error: output.error,
      },
    });
    return;
  }

  if (output.type !== "session.message.persisted") return;
  if (shouldClearStreamSnapshotForMessage(output.message)) {
    await clearSessionStreamSnapshot({ spaceId: output.spaceId, sessionId: output.sessionId });
  }
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: output.type,
    spaceId: output.spaceId,
    sessionId: output.sessionId,
    payload: {
      message: toRealtimeMessageRecord(output.message),
    },
  });
};

const dispatchSessionOutputToChannels = async (output: GatewaySessionOutput) => {
  if (output.type !== "session.message.persisted") return;
  const message = output.message;
  if (message.role !== "assistant") return;

  const bindings = await getBindingsBySessionId(output.sessionId);
  if (bindings.length > 0) {
    for (const binding of bindings) {
      const turnAnchorMessageId = typeof message.meta?.anchorUserMessageId === "string"
        ? (message.meta.anchorUserMessageId as string)
        : message.id;
      const anchorRef = await getProviderMessageRefBySessionMessage({
        spaceChannelId: binding.spaceChannelId,
        sessionMessageId: turnAnchorMessageId,
        direction: "inbound",
      }).catch(() => null);

      await dispatchOutboundMessage({
        spaceChannelId: binding.spaceChannelId,
        spaceId: output.spaceId,
        spaceSessionId: output.sessionId,
        sessionMessageId: message.id,
        provider: binding.provider,
        externalChatId: binding.externalChatId,
        replyToExternalMessageId: anchorRef?.externalMessageId ?? undefined,
        content: message.content,
        meta: {
          sessionOutput: output,
          bindingKey: binding.bindingKey,
          sessionMessageRole: message.role,
          turnAnchorMessageId,
        },
      }).catch((error) => logger.error("[SessionOutput] failed to dispatch bound outbound message", { spaceId: output.spaceId, sessionId: output.sessionId, spaceChannelId: binding.spaceChannelId, sessionMessageId: message.id, error }));
    }
    return;
  }

  const channels = await db.select().from(spaceChannels).where(eq(spaceChannels.spaceId, output.spaceId));
  for (const channel of channels as Array<{ id: string }>) {
    await dispatchOutboundMessage({
      spaceChannelId: channel.id,
      spaceId: output.spaceId,
      spaceSessionId: output.sessionId,
      sessionMessageId: message.id,
      content: message.content,
      meta: {
        sessionOutput: output,
        sessionMessageRole: message.role,
      },
    }).catch((error) => logger.error("[SessionOutput] failed to dispatch channel outbound message", { spaceId: output.spaceId, sessionId: output.sessionId, spaceChannelId: channel.id, sessionMessageId: message.id, error }));
  }
};

export const dispatchSessionOutput = async (output: GatewaySessionOutput) => {
  await dispatchSessionOutputToRealtime(output);
  await dispatchSessionOutputToChannels(output);
};

export const dispatchTurnUpdated = async (input: { spaceId: string; sessionId: string; turn: SessionTurnRecord }) => {
  const resolved = await resolveRealtimeTurnIdentity(input.turn);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.updated",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: {
      turn: toRealtimeTurnRecord(resolved.turn),
    },
  });
};

const truncateTurnPreview = (text: string | null | undefined) => {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

const resolveRealtimeTurnIdentity = async (turn: SessionTurnRecord) => {
  if (!turn.userUuid) return { turn, userRooms: [] };
  const identity = await resolveStoredPrincipalUser(turn.userUuid);
  return {
    turn: {
      ...turn,
      userUuid: identity.uuid,
      authorProfile: turn.authorProfile
        ? { ...turn.authorProfile, userUuid: identity.uuid }
        : turn.authorProfile,
    },
    userRooms: getIdentityKeys(identity).map(getRealtimeUserRoom),
  };
};

export const dispatchTurnFinalized = async (input: { spaceId: string; sessionId: string; turn: SessionTurnRecord }) => {
  const resolved = await resolveRealtimeTurnIdentity(input.turn);
  await clearSessionStreamSnapshot({ spaceId: input.spaceId, sessionId: input.sessionId });
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.finalized",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: {
      turn: toRealtimeTurnRecord(resolved.turn),
    },
  });

  if (resolved.userRooms.length === 0) return;
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.notify",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    rooms: resolved.userRooms,
    payload: {
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: resolved.turn.id,
      status: resolved.turn.status,
      finishReason: resolved.turn.summary?.finishReason ?? null,
      userPreview: truncateTurnPreview(resolved.turn.userText),
      durationMs: resolved.turn.durationMs,
      stepCount: resolved.turn.intermediateSummary?.messageCount ?? null,
      sequence: resolved.turn.sequence ?? null,
      provider: resolved.turn.provider,
      model: resolved.turn.model,
      completedAt: resolved.turn.completedAt,
    },
  });
};

export const dispatchSessionOutputs = async (outputs: GatewaySessionOutput[]) => {
  for (const output of outputs) {
    await dispatchSessionOutput(output);
  }
};
