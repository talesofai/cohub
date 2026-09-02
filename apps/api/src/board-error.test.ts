import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardItemValidationError } from "@cohub/core/board";
import {
  boardErrorBody,
  boardErrorResponse,
  boardInputDiagnostics,
} from "./board-error.js";
import { BoardServiceError } from "./board-ops.js";

test("Board errors preserve concise structured diagnostics", () => {
  const diagnostic = {
    severity: "error" as const,
    code: "INVALID_BOARD_GEOMETRY" as const,
    message: "draw points do not match the item frame",
    path: "item.props.points",
  };
  const validation = boardErrorResponse(new BoardItemValidationError([diagnostic]));
  assert.deepEqual(boardErrorBody(validation), {
    code: "INVALID_BOARD_ITEM",
    message: diagnostic.message,
    diagnostics: [diagnostic],
  });

  const conflict = boardErrorResponse(new BoardServiceError(409, "item already exists: title", "ITEM_EXISTS"));
  assert.deepEqual(boardErrorBody(conflict), {
    code: "ITEM_EXISTS",
    message: "item already exists: title",
  });
});

test("Board input issues use stable paths", () => {
  assert.deepEqual(boardInputDiagnostics({
    issues: [{ path: ["items", 0, "frame", "width"], message: "Expected a positive number" }],
  }), [{
    severity: "error",
    code: "INVALID_BOARD_INPUT",
    message: "Expected a positive number",
    path: "input.items.0.frame.width",
  }]);
});
