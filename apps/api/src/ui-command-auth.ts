import type { UiCommandRecord } from "@cohub/protocol/ui-command";

export function canWorkSessionSettleUiCommand(
  record: UiCommandRecord | null,
  input: { actorUserId: string; workId: string },
): record is UiCommandRecord {
  return Boolean(
    record &&
      record.actorUserId === input.actorUserId &&
      record.command.type === "preview.show" &&
      record.command.preview.workId === input.workId &&
      record.command.request !== undefined,
  );
}
