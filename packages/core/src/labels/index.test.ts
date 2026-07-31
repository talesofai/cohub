import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLabelPathsAllowed, parseLabelRefs } from "./index.js";

test("user label paths reject reserved roots before any write", () => {
  assert.throws(
    () => assertLabelPathsAllowed(parseLabelRefs(["Source/API"])),
    /label path "Source" is reserved/,
  );
  assert.doesNotThrow(() => assertLabelPathsAllowed(parseLabelRefs(["Area/API"])));
  assert.doesNotThrow(() => assertLabelPathsAllowed(parseLabelRefs(["Source/API"]), "system"));
});
