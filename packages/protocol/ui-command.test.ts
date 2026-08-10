import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTerminalUiCommandStatus,
  isUiSurfaceMethod,
  measureUiCommandPayload,
  parseUiCommand,
  parseUiCommandError,
  parseUiCommandId,
  UI_COMMAND_DEFAULT_TIMEOUT_MS,
  UI_COMMAND_ERROR_CODE_MAX_LENGTH,
  UI_COMMAND_ERROR_MESSAGE_MAX_LENGTH,
  UI_COMMAND_LABEL_MAX_LENGTH,
  UI_COMMAND_LAUNCH_MAX_LENGTH,
  UI_COMMAND_MAX_BYTES,
  UI_COMMAND_MAX_TIMEOUT_MS,
  UI_COMMAND_PAYLOAD_MAX_BYTES,
  UI_COMMAND_PENDING_TTL_SECONDS,
  UI_COMMAND_SETTLEMENT_GRACE_SECONDS,
  UI_COMMAND_TERMINAL_TTL_SECONDS,
} from "./src/ui-command.js";

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const show = (preview: unknown, request?: unknown) =>
  parseUiCommand({ type: "preview.show", preview, ...(request ? { request } : {}) });

describe("parseUiCommand", () => {
  it("normalizes a full command, prefixing query and hash", () => {
    const parsed = show(
      { kind: "work", workId: WORK_ID, label: " Launch ", launch: { search: "view=timeline", hash: "today" } },
      { method: "selection.get", input: { scope: "active" } },
    );
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.command, {
      type: "preview.show",
      preview: {
        kind: "work",
        workId: WORK_ID,
        label: "Launch",
        launch: { search: "?view=timeline", hash: "#today" },
      },
      request: { method: "selection.get", input: { scope: "active" } },
    });
  });

  it("accepts a bare preview.show", () => {
    assert.deepEqual(show({ kind: "work", workId: WORK_ID }).command, {
      type: "preview.show",
      preview: { kind: "work", workId: WORK_ID },
    });
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const [expected, preview, request] of [
    [/command\.preview\.kind/, { kind: "file", workId: WORK_ID }],
    [/workId is required/, { kind: "work" }],
    // A slug or url must be resolved to an id before a command exists.
    [/must be a Work id/, { kind: "work", workId: "alice/studio/launch" }],
    [/must be a Work id/, { kind: "work", workId: "../../etc" }],
    [
      /label exceeds/,
      { kind: "work", workId: WORK_ID, label: "x".repeat(UI_COMMAND_LABEL_MAX_LENGTH + 1) },
    ],
    [
      /launch\.search exceeds/,
      {
        kind: "work",
        workId: WORK_ID,
        launch: { search: `?q=${"x".repeat(UI_COMMAND_LAUNCH_MAX_LENGTH)}` },
      },
    ],
    [/unsupported format/, { kind: "work", workId: WORK_ID }, { method: "drop table; rm -rf" }],
    [
      /exceeds/,
      { kind: "work", workId: WORK_ID },
      { method: "big", input: "x".repeat(UI_COMMAND_PAYLOAD_MAX_BYTES + 1) },
    ],
    [/JSON-serializable/, { kind: "work", workId: WORK_ID }, { method: "cycle", input: cyclic }],
  ] as const) {
    it(`rejects input matching ${expected}`, () => {
      assert.match(show(preview, request).error ?? "", expected);
    });
  }

  it("rejects an unknown command type", () => {
    assert.match(parseUiCommand({ type: "preview.open" }).error ?? "", /command\.type/);
  });

  it("keeps a maximal legal command inside the envelope cap", () => {
    // Every field is individually legal; together they must still fit.
    const parsed = show(
      {
        kind: "work",
        workId: WORK_ID,
        label: "x".repeat(UI_COMMAND_LABEL_MAX_LENGTH),
        launch: { search: `?a=${"x".repeat(UI_COMMAND_LAUNCH_MAX_LENGTH - 3)}` },
      },
      { method: "big", input: "y".repeat(UI_COMMAND_PAYLOAD_MAX_BYTES - 100) },
    );
    assert.equal(parsed.error, null);
    assert.ok((measureUiCommandPayload(parsed.command) ?? 0) <= UI_COMMAND_MAX_BYTES);
  });
});

describe("ui command helpers", () => {
  it("keeps wait limits within the pending command lifetime", () => {
    assert.equal(UI_COMMAND_DEFAULT_TIMEOUT_MS, 10 * 60 * 1_000);
    assert.equal(UI_COMMAND_MAX_TIMEOUT_MS, 12 * 60 * 60 * 1_000);
    assert.equal(UI_COMMAND_SETTLEMENT_GRACE_SECONDS, 10 * 60);
    assert.equal(
      UI_COMMAND_PENDING_TTL_SECONDS,
      UI_COMMAND_MAX_TIMEOUT_MS / 1_000 + UI_COMMAND_SETTLEMENT_GRACE_SECONDS,
    );
    assert.equal(UI_COMMAND_TERMINAL_TTL_SECONDS, 30 * 60);
  });

  it("treats every status but pending as terminal", () => {
    assert.equal(isTerminalUiCommandStatus("pending"), false);
    assert.equal(isTerminalUiCommandStatus("applied"), true);
    assert.equal(isTerminalUiCommandStatus("timeout"), true);
  });

  it("accepts only short opaque command ids, since they become Redis keys", () => {
    assert.equal(parseUiCommandId("  retry-1  "), "retry-1");
    assert.equal(parseUiCommandId("a".repeat(64))?.length, 64);
    for (const invalid of ["a".repeat(65), "", "has space", "ui:command:v1:injected", 42]) {
      assert.equal(parseUiCommandId(invalid), null, String(invalid));
    }
  });

  it("caps a reported error and falls back to the status", () => {
    const capped = parseUiCommandError(
      { code: "c".repeat(500), message: "m".repeat(50_000) },
      "rejected",
    );
    assert.equal(capped?.code.length, UI_COMMAND_ERROR_CODE_MAX_LENGTH);
    assert.equal(capped?.message.length, UI_COMMAND_ERROR_MESSAGE_MAX_LENGTH);

    assert.deepEqual(parseUiCommandError({}, "rejected"), {
      code: "rejected",
      message: "UI command failed",
    });
    assert.equal(parseUiCommandError(null, "rejected"), null);
  });

  it("accepts namespaced method names only", () => {
    assert.equal(isUiSurfaceMethod("selection.get"), true);
    assert.equal(isUiSurfaceMethod("board:focus-node"), true);
    assert.equal(isUiSurfaceMethod("1bad"), false);
    assert.equal(isUiSurfaceMethod("has space"), false);
  });
});
