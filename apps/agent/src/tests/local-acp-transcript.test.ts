import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  appendLocalAcpAssistantMessages,
  appendLocalAcpUserMessage,
  type LocalAcpAssistantTranscriptInput,
  type LocalAcpTranscriptInput,
} from "../local-acp-transcript.js";
import { SessionManager } from "../runtime/local-session-manager.js";

const baseInput: LocalAcpTranscriptInput = {
  spaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "88888888-8888-4888-8888-888888888888",
  turnId: "99999999-9999-4999-8999-999999999999",
  executionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  startedAt: "2026-09-03T00:00:00.000Z",
};

const assistantInput: LocalAcpAssistantTranscriptInput = {
  ...baseInput,
  assistantMessageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  provider: "codex",
  model: null,
  stopReason: "end_turn",
  usage: { input: 10, output: 5, totalTokens: 15 },
  completedAt: "2026-09-03T00:00:01.000Z",
  content: [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "before" },
    { type: "tool_use", id: "tool-1", name: "bash", input: { command: "true" } },
    { type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false },
    { type: "text", text: "after" },
  ],
};

test("local ACP transcript projects valid JSONL messages and deduplicates retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-local-acp-transcript-"));
  const sessionsDir = join(root, "sessions");
  const sessionFile = join(sessionsDir, "session.jsonl");
  try {
    const manager = SessionManager.create(root, sessionsDir);
    manager.newSession({ id: baseInput.sessionId });
    manager.setSessionFile(sessionFile);

    const userEntryId = appendLocalAcpUserMessage(manager, baseInput, [{ type: "text", text: "run" }]);
    const finalEntryId = appendLocalAcpAssistantMessages(manager, assistantInput);
    await manager.flush();
    await manager.close();

    const reopened = await SessionManager.open(sessionFile, sessionsDir);
    const firstEntries = reopened.getEntries();
    const messageEntries = firstEntries.flatMap((entry) => entry.type === "message" ? [entry] : []);
    assert.deepEqual(messageEntries.map((entry) => entry.message.role), ["user", "assistant", "toolResult", "assistant"]);
    assert.equal(messageEntries.at(0)?.id, userEntryId);
    assert.equal(messageEntries.at(-1)?.id, finalEntryId);
    const assistantEntries = messageEntries.filter((entry) => entry.message.role === "assistant");
    const firstAssistant = assistantEntries[0]?.message as unknown as { content?: Array<{ type: string }> };
    const finalAssistant = assistantEntries[1]?.message as unknown as { meta?: { messageKind?: string } };
    assert.deepEqual((firstAssistant.content ?? []).map((block) => block.type), ["thinking", "text", "toolCall"]);
    assert.equal(finalAssistant.meta?.messageKind, "assistant_final");
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
    assert.equal(reopened.buildSessionContext().model, null);

    const duplicateUserId = appendLocalAcpUserMessage(reopened, baseInput, [{ type: "text", text: "run" }]);
    const duplicateFinalId = appendLocalAcpAssistantMessages(reopened, assistantInput);
    await reopened.flush();
    assert.equal(duplicateUserId, userEntryId);
    assert.equal(duplicateFinalId, finalEntryId);
    assert.throws(
      () => appendLocalAcpUserMessage(reopened, baseInput, [{ type: "text", text: "different" }]),
      /different content/,
    );
    assert.equal(reopened.getEntries().flatMap((entry) => entry.type === "message" ? [entry] : []).length, 4);

    const jsonl = await readFile(sessionFile, "utf8");
    assert.equal(jsonl.endsWith("\n"), true);
    assert.equal(jsonl.trim().split("\n").length, 5);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
