import assert from "node:assert/strict";
import { test } from "node:test";
import { getMergeableFollowupPrefix } from "../followup-batch.js";

const turn = (id: string, systemInstructions?: string | null) => ({
  id,
  meta: systemInstructions == null ? {} : { systemInstructions },
});

test("followup batches claim the longest compatible prefix", () => {
  const queued = [turn("1", "A"), turn("2", "A"), turn("3", "B"), turn("4", "A")];
  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(2)).map(({ id }) => id), ["3"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(3)).map(({ id }) => id), ["4"]);
});

test("followup batches keep null and explicit instructions isolated", () => {
  const queued = [turn("1"), turn("2", "  "), turn("3", "B"), turn("4", "B")];
  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(2)).map(({ id }) => id), ["3", "4"]);
});

test("empty followup queues have no mergeable prefix", () => {
  assert.deepEqual(getMergeableFollowupPrefix([]), []);
});
