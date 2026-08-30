import assert from "node:assert/strict";
import test from "node:test";
import type { NativeTurnBundleV1 } from "@cohub/protocol";
import { buildNativeProjectedGroups } from "../native-projection.js";

const bundle = (historyDelta: NativeTurnBundleV1["historyDelta"]): NativeTurnBundleV1 => ({
  version: 1,
  executionAttemptId: "00000000-0000-4000-8000-000000000001",
  workspacePolicyVersion: 1,
  integrationPolicyVersion: 1,
  sessionMirrorMode: "full",
  bundleId: "bundle",
  provider: "pi",
  providerVersion: "0.81.1",
  adapterVersion: "locald-pi-v1",
  nativeSessionKey: "session",
  nativeTurnKey: "turn",
  previousNativeCursor: null,
  nextNativeCursor: {},
  cohubTranscriptBase: null,
  workspaceExecutionBase: {
    executionAttemptId: "00000000-0000-4000-8000-000000000001",
    canonicalSnapshotId: null,
    localSnapshotId: null,
    leaseEpoch: 1,
  },
  events: [],
  historyDelta,
  fidelityHint: "exact",
  diagnostics: {},
});

test("native projection groups a tool result with its assistant call", () => {
  const groups = buildNativeProjectedGroups(bundle([
    { nativeMessageKey: "user", role: "user", content: [{ type: "text", text: "run" }] },
    {
      nativeMessageKey: "assistant-tool",
      role: "assistant",
      content: [{ type: "text", text: "checking" }],
      toolCalls: [{ nativeToolCallKey: "call", name: "bash", arguments: { command: "true" } }],
    },
    {
      nativeMessageKey: "result",
      role: "tool_result",
      nativeToolCallKey: "call",
      content: [],
      toolResult: { isError: false, content: [{ type: "text", text: "ok" }] },
    },
    { nativeMessageKey: "assistant-final", role: "assistant", content: [{ type: "text", text: "done" }] },
  ]), ["entry-user", "entry-tool", "entry-result", "entry-final"]);

  assert.equal(groups.length, 3);
  assert.equal(groups[1]?.messageKind, "assistant_intermediate");
  assert.deepEqual(groups[1]?.entryIds, ["entry-tool", "entry-result"]);
  assert.deepEqual(groups[1]?.content.map((block) => block.type), ["text", "tool_use", "tool_result"]);
  assert.equal(groups[2]?.messageKind, "assistant_final");
});

test("native projection does not attach an ambiguous orphan result", () => {
  const groups = buildNativeProjectedGroups(bundle([
    {
      nativeMessageKey: "assistant-one",
      role: "assistant",
      content: [],
      toolCalls: [{ nativeToolCallKey: "call-one", name: "one", arguments: {} }],
    },
    {
      nativeMessageKey: "assistant-two",
      role: "assistant",
      content: [],
      toolCalls: [{ nativeToolCallKey: "call-two", name: "two", arguments: {} }],
    },
    {
      nativeMessageKey: "orphan-result",
      role: "tool_result",
      content: [],
      toolResult: { isError: false, content: [{ type: "text", text: "unknown" }] },
    },
  ]), ["entry-one", "entry-two", "entry-orphan"]);

  assert.equal(groups.length, 3);
  assert.equal(groups[2]?.messageKind, "tool_result");
  assert.deepEqual(groups[0]?.entryIds, ["entry-one"]);
  assert.deepEqual(groups[1]?.entryIds, ["entry-two"]);
});

test("native projection uses an explicit parent for a result without a call key", () => {
  const groups = buildNativeProjectedGroups(bundle([
    {
      nativeMessageKey: "assistant-tool",
      role: "assistant",
      content: [],
      toolCalls: [{ nativeToolCallKey: "call", name: "read", arguments: {} }],
    },
    {
      nativeMessageKey: "result",
      nativeParentMessageKey: "assistant-tool",
      role: "tool_result",
      content: [],
      toolResult: { isError: false, content: [{ type: "text", text: "value" }] },
    },
  ]), ["entry-tool", "entry-result"]);

  assert.equal(groups.length, 1);
  const toolUse = groups[0]?.content.find((block) => block.type === "tool_use");
  const toolResult = groups[0]?.content.find((block) => block.type === "tool_result");
  assert.equal(toolUse?.type === "tool_use" ? toolUse.id : null, toolResult?.type === "tool_result" ? toolResult.tool_use_id : null);
});
