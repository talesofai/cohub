import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiCommandRecord } from "@cohub/protocol/ui-command";
import { canWorkSessionSettleUiCommand } from "./ui-command-auth.js";

const record = (overrides: Partial<UiCommandRecord> = {}): UiCommandRecord => ({
  version: 1,
  commandId: "command-1",
  status: "pending",
  command: {
    type: "preview.show",
    preview: {
      kind: "work",
      workId: "123e4567-e89b-42d3-a456-426614174000",
    },
    request: { method: "image.open" }
  },
  actorUserId: "user-1",
  targetClientId: "client-1",
  source: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  settledAt: null,
  ...overrides,
});

const input = {
  actorUserId: "user-1",
  workId: "123e4567-e89b-42d3-a456-426614174000",
};

describe("canWorkSessionSettleUiCommand", () => {
  it("accepts only a command targeting the current Work", () => {
    assert.equal(canWorkSessionSettleUiCommand(record(), input), true);
  });

  it("rejects another user or Work", () => {
    assert.equal(
      canWorkSessionSettleUiCommand(record({ actorUserId: "user-2" }), input),
      false,
    );
    assert.equal(
      canWorkSessionSettleUiCommand(record(), { ...input, workId: "other-work" }),
      false,
    );
  });
});
