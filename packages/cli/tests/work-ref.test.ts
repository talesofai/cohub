import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkRef } from "../src/work-ref.js";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("parseWorkRef accepts ids and management URLs", () => {
  assert.deepEqual(parseWorkRef(id), { id });
  assert.deepEqual(parseWorkRef(`https://cohub.run/spaces/${id}/works/${id}`), { id });
});

test("parseWorkRef accepts public references", () => {
  const expected = { username: "alice", spaceSlug: "studio", workSlug: "launch" };
  assert.deepEqual(parseWorkRef("alice/studio/launch"), expected);
  assert.deepEqual(parseWorkRef("cohub://works/alice/studio/launch"), expected);
});

test("parseWorkRef preserves launch state so it can be forwarded to the Work", () => {
  assert.deepEqual(parseWorkRef("https://cohub.run/alice/studio/w/launch?view=one"), {
    username: "alice",
    spaceSlug: "studio",
    workSlug: "launch",
    search: "?view=one",
  });
  assert.deepEqual(parseWorkRef("cohub://works/alice/studio/launch?tab=a#today"), {
    username: "alice",
    spaceSlug: "studio",
    workSlug: "launch",
    search: "?tab=a",
    hash: "#today",
  });
});

test("parseWorkRef rejects ambiguous or invalid references", () => {
  assert.throws(() => parseWorkRef("launch"), /Work must be/);
  assert.throws(() => parseWorkRef("alice/studio/bad.slug"), /Work must be/);
  assert.throws(() => parseWorkRef("cohub://works/-alice/studio/launch"), /Work must be/);
  assert.throws(() => parseWorkRef("cohub://works/alice--dev/studio/launch"), /Work must be/);
  assert.throws(() => parseWorkRef("https://cohub.run/alice/studio/w/launch/extra"), /Work must be/);
});
