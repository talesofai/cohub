import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSpaceTurnCursor,
  encodeSpaceTurnCursor,
  InvalidSpaceTurnListQueryError,
} from "./space-turns.js";

const boundary = {
  createdAt: "2026-07-31T08:09:10.123Z",
  id: "123e4567-e89b-42d3-a456-426614174000",
};

test("space turn cursor preserves the time and UUID boundary", () => {
  const decoded = decodeSpaceTurnCursor(encodeSpaceTurnCursor(boundary));
  assert.equal(decoded?.createdAt.toISOString(), boundary.createdAt);
  assert.equal(decoded?.id, boundary.id);
});

test("space turn cursor rejects malformed values", () => {
  assert.throws(
    () => decodeSpaceTurnCursor("not-a-cursor"),
    InvalidSpaceTurnListQueryError,
  );
  assert.throws(
    () => encodeSpaceTurnCursor({ ...boundary, id: "not-a-uuid" }),
    InvalidSpaceTurnListQueryError,
  );
});
