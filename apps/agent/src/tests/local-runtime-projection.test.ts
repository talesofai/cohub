import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRuntimeEvent,
  createTurnProjection,
  mapRuntimeStopReason,
  parseRuntimeUsage,
  syncToolBlocks,
} from "../local-runtime/projection.js";

test("streams text and thinking into separate blocks keyed by item id", () => {
  const state = createTurnProjection();
  assert.equal(applyRuntimeEvent(state, { kind: "thinking.delta", payload: { text: "plan ", itemId: "m1" } }), true);
  assert.equal(applyRuntimeEvent(state, { kind: "thinking.delta", payload: { text: "more", itemId: "m1" } }), true);
  assert.equal(applyRuntimeEvent(state, { kind: "text.delta", payload: { text: "hello ", itemId: "m1" } }), true);
  assert.equal(applyRuntimeEvent(state, { kind: "text.delta", payload: { text: "world", itemId: "m1" } }), true);
  assert.deepEqual(state.content.map((block) => block.type === "thinking" ? ["thinking", block.thinking] : block.type === "text" ? ["text", block.text] : [block.type]), [
    ["thinking", "plan more"],
    ["text", "hello world"],
  ]);
});

test("tool events become tool_use and tool_result blocks", () => {
  const state = createTurnProjection();
  applyRuntimeEvent(state, { kind: "text.delta", payload: { text: "before" } });
  applyRuntimeEvent(state, { kind: "tool.started", payload: { id: "t1", name: "bash", input: { command: "true" } } });
  applyRuntimeEvent(state, { kind: "tool.completed", payload: { id: "t1", status: "completed", output: "ok" } });
  applyRuntimeEvent(state, { kind: "text.delta", payload: { text: "after" } });
  syncToolBlocks(state);
  assert.deepEqual(state.content.map((block) => block.type), ["text", "text", "tool_use", "tool_result"]);
  const use = state.content.find((block) => block.type === "tool_use");
  const result = state.content.find((block) => block.type === "tool_result");
  assert.equal(use?.type === "tool_use" && use.name, "bash");
  assert.deepEqual(use?.type === "tool_use" && use.input, { command: "true" });
  assert.equal(result?.type === "tool_result" && result.content, "ok");
  assert.equal(result?.type === "tool_result" && result.is_error, false);
});

test("failed tool events mark the result as an error", () => {
  const state = createTurnProjection();
  applyRuntimeEvent(state, { kind: "tool.started", payload: { id: "t1", name: "edit" } });
  applyRuntimeEvent(state, { kind: "tool.completed", payload: { id: "t1", status: "failed", output: "permission denied" } });
  syncToolBlocks(state);
  const result = state.content.find((block) => block.type === "tool_result");
  assert.equal(result?.type === "tool_result" && result.is_error, true);
  assert.equal(result?.type === "tool_result" && result.content, "permission denied");
});

test("usage updates normalize provider shapes and unknown events stay inert", () => {
  const state = createTurnProjection();
  assert.equal(applyRuntimeEvent(state, { kind: "usage", payload: { usage: { used: 120 } } }), true);
  assert.deepEqual(state.usage, { totalTokens: 120 });
  assert.deepEqual(parseRuntimeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: { amount: 0.01, currency: "USD" } }), { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } });
  assert.equal(applyRuntimeEvent(state, { kind: "permission.requested", payload: { requestId: "r1" } }), false);
  assert.equal(state.content.length, 0);
});

test("terminal stop reasons map to Cohub values", () => {
  assert.equal(mapRuntimeStopReason("cancelled"), "aborted");
  assert.equal(mapRuntimeStopReason("end_turn"), "end_turn");
  assert.equal(mapRuntimeStopReason(null), null);
});
