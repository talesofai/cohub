import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUserSpaceGroupSnapshot,
  isProtectedUserLabel,
  isReservedUserLabelName,
  MAX_CUSTOM_USER_LABELS,
  normalizeLabelName,
  PINNED_LABEL_NAME,
  PINNED_LABEL_SYSTEM_KEY,
  UserLabelError,
} from "./user-labels.js";

test("normalizeLabelName trims and rejects empty, slash, and overlong names", () => {
  assert.equal(normalizeLabelName("  Work  "), "Work");
  assert.throws(() => normalizeLabelName(""), /1-80/);
  assert.throws(() => normalizeLabelName("Area/Frontend"), /cannot contain "\/"/);
  assert.throws(() => normalizeLabelName("x".repeat(81)), /1-80/);
});

test("create refuses reserved Pinned names", () => {
  assert.equal(isReservedUserLabelName("Pinned"), true);
  assert.equal(isReservedUserLabelName(" pinned "), true);
  assert.equal(isReservedUserLabelName("PINNED"), true);
  assert.equal(isReservedUserLabelName("Work"), false);
});

test("delete refuses Pinned and user:pinned", () => {
  assert.equal(isProtectedUserLabel({ name: "Pinned", systemKey: PINNED_LABEL_SYSTEM_KEY }), true);
  assert.equal(isProtectedUserLabel({ name: "Pinned", systemKey: null }), true);
  assert.equal(isProtectedUserLabel({ name: "Work", systemKey: null }), false);
});

test("custom user labels are capped at 50", () => {
  assert.equal(MAX_CUSTOM_USER_LABELS, 50);
  const error = new UserLabelError(`custom user labels are limited to ${MAX_CUSTOM_USER_LABELS}`, "limit");
  assert.equal(error.kind, "limit");
  assert.match(error.message, /limited to 50/);
});

test("reserved and missing labels use conflict/not-found kinds", () => {
  const reserved = new UserLabelError(`label name "${PINNED_LABEL_NAME}" is reserved`, "reserved");
  const missing = new UserLabelError("label not found", "not_found");
  assert.equal(reserved.kind, "reserved");
  assert.equal(missing.kind, "not_found");
});

test("snapshot includes Pinned and groups ordered space ids", () => {
  const groups = buildUserSpaceGroupSnapshot(
    [
      { id: "pinned", name: "Pinned", systemKey: PINNED_LABEL_SYSTEM_KEY, rank: 0 },
      { id: "work", name: "Work", systemKey: null, rank: 20 },
      { id: "empty", name: "Empty", systemKey: null, rank: 10 },
    ],
    [
      { labelId: "work", resourceRef: "space-b", rank: 20, createdAt: new Date("2026-01-02"), id: "a2" },
      { labelId: "work", resourceRef: "space-a", rank: 10, createdAt: new Date("2026-01-01"), id: "a1" },
      { labelId: "pinned", resourceRef: "space-a", rank: 10, createdAt: new Date("2026-01-01"), id: "p1" },
    ],
  );

  assert.deepEqual(groups.map((group) => group.name), ["Pinned", "Empty", "Work"]);
  assert.deepEqual(groups[0]?.spaceIds, ["space-a"]);
  assert.deepEqual(groups[1]?.spaceIds, []);
  assert.deepEqual(groups[2]?.spaceIds, ["space-a", "space-b"]);
});

test("snapshot allows a space in multiple groups", () => {
  const groups = buildUserSpaceGroupSnapshot(
    [
      { id: "clients", name: "Clients", systemKey: null, rank: 10 },
      { id: "urgent", name: "Urgent", systemKey: null, rank: 20 },
    ],
    [
      { labelId: "clients", resourceRef: "space-shared", rank: 10, createdAt: new Date("2026-01-01"), id: "c1" },
      { labelId: "urgent", resourceRef: "space-shared", rank: 10, createdAt: new Date("2026-01-01"), id: "u1" },
      { labelId: "urgent", resourceRef: "space-only-urgent", rank: 20, createdAt: new Date("2026-01-02"), id: "u2" },
    ],
  );

  assert.deepEqual(groups[0]?.spaceIds, ["space-shared"]);
  assert.deepEqual(groups[1]?.spaceIds, ["space-shared", "space-only-urgent"]);
});
