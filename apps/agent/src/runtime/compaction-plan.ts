import type { ContextCompactionScope } from "@cohub/protocol/model";

type CompactionPreparationLike = {
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
  isSplitTurn: boolean;
};

export function getCompactionSummaryMessageCount(
  preparation: CompactionPreparationLike,
): number {
  return preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
}

export function resolveCompactionScope(
  preparation: Pick<CompactionPreparationLike, "isSplitTurn">,
  firstKeptTurnId: string | null,
): { scope: ContextCompactionScope; ownerTurnId: string | null } {
  return preparation.isSplitTurn && firstKeptTurnId
    ? { scope: "within_turn", ownerTurnId: firstKeptTurnId }
    : { scope: "between_turns", ownerTurnId: null };
}

export function validateCompactionEffect(input: {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  inputBudget: number;
}): "compaction_no_effect" | "compaction_still_over_budget" | null {
  if (input.estimatedTokensAfter >= input.estimatedTokensBefore) {
    return "compaction_no_effect";
  }
  if (input.estimatedTokensAfter >= input.inputBudget) {
    return "compaction_still_over_budget";
  }
  return null;
}
