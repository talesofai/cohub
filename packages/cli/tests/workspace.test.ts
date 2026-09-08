import assert from "node:assert/strict";
import test from "node:test";
import { resolveInitialChoice } from "../src/commands/workspace.js";

void test("workspace attach defaults only an empty root to use-cloud", () => {
  assert.equal(resolveInitialChoice({}, false), "use-cloud");
});

void test("workspace attach preserves explicit initial strategies", () => {
  assert.equal(resolveInitialChoice({ merge: true }, true), "merge");
  assert.equal(resolveInitialChoice({ useCloud: true }, true), "use-cloud");
  assert.equal(resolveInitialChoice({ useLocal: true }, true), "use-local");
});

void test("workspace attach rejects a non-empty root without a strategy", () => {
  assert.throws(() => resolveInitialChoice({}, true), /Initial strategy required/);
});

void test("workspace attach rejects competing strategies", () => {
  assert.throws(
    () => resolveInitialChoice({ merge: true, useCloud: true }, true),
    /Choose one initial strategy/,
  );
});
