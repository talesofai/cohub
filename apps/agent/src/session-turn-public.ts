import { sanitizePromptMetaForClient } from "@cohub/core/sessions";
import type { SessionTurnRecord } from "@cohub/protocol/model";

export const toPublicSessionTurnRecord = (
  turn: SessionTurnRecord,
): SessionTurnRecord => ({
  ...turn,
  meta: sanitizePromptMetaForClient(turn.meta),
});
