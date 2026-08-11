import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../runtime/local-session-manager.js";

function firstMessageText(manager: SessionManager): string | undefined {
  const message = manager.buildSessionContext().messages[0] as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  return message?.content?.find((part) => part.type === "text")?.text;
}

const root = await mkdtemp(join(tmpdir(), "cohub-local-session-manager-"));
try {
  const sessionsDir = join(root, "sessions");
  const sessionFile = join(sessionsDir, "session.jsonl");
  const manager = SessionManager.create(root, sessionsDir);
  manager.newSession({ id: "session" });
  manager.setSessionFile(sessionFile);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
    meta: { messageId: "user-message-1" },
  } as never);

  assert.equal(manager.hasUserMessage("user-message-1"), true);
  assert.equal(manager.hasUserMessage("missing"), false);

  await manager.flush();
  const content = await readFile(sessionFile, "utf-8");
  assert.equal(content.trim().split("\n").length, 2);

  const reopened = await SessionManager.open(sessionFile, sessionsDir);
  assert.equal(reopened.hasUserMessage("user-message-1"), true);
  assert.equal(reopened.buildSessionContext().messages.length, 1);
  assert.deepEqual(reopened.getSessionAffinity(), { sessionId: "session", threadId: "session" });

  const childSessionFile = join(sessionsDir, "child.jsonl");
  await reopened.createBranchedSession(reopened.getBranchEntries().at(-1)?.id ?? "", {
    id: "child",
    filePath: childSessionFile,
  });
  const child = await SessionManager.open(childSessionFile, sessionsDir);
  assert.deepEqual(child.getSessionAffinity(), { sessionId: "session", threadId: "child" });

  const grandchildSessionFile = join(sessionsDir, "grandchild.jsonl");
  await child.createBranchedSession(child.getBranchEntries().at(-1)?.id ?? "", {
    id: "grandchild",
    filePath: grandchildSessionFile,
  });
  const grandchild = await SessionManager.open(grandchildSessionFile, sessionsDir);
  assert.deepEqual(grandchild.getSessionAffinity(), { sessionId: "session", threadId: "grandchild" });

  const unicodeSeparatorText = "before emoji \u{1f680}\u2028between\u2029after";
  const legacySeparatorFile = join(sessionsDir, "legacy-unicode-separators.jsonl");
  const legacySeparatorContent = [
    JSON.stringify({ type: "session", version: 3, id: "legacy-separators", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "legacy", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: unicodeSeparatorText }], timestamp: Date.now() } }),
    JSON.stringify({ type: "message", id: "after-legacy", parentId: "legacy", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "still valid" }], timestamp: Date.now() } }),
    "",
  ].join("\n");
  assert.equal(legacySeparatorContent.includes("\u2028"), true);
  assert.equal(legacySeparatorContent.includes("\u2029"), true);
  await writeFile(legacySeparatorFile, legacySeparatorContent);
  const legacySeparators = await SessionManager.open(legacySeparatorFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(legacySeparators.getEntries().length, 2);
  assert.equal(firstMessageText(legacySeparators), unicodeSeparatorText);

  const chunkBoundaryFile = join(sessionsDir, "chunk-boundary-unicode-separators.jsonl");
  const chunkBoundaryText = `${"x".repeat(70_000)}\u2028chunk-boundary\u2029end`;
  await writeFile(chunkBoundaryFile, [
    JSON.stringify({ type: "session", version: 3, id: "chunk-boundary", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "chunk-boundary-entry", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: chunkBoundaryText }], timestamp: Date.now() } }),
    "",
  ].join("\r\n"));
  const chunkBoundary = await SessionManager.open(chunkBoundaryFile, sessionsDir);
  assert.equal(firstMessageText(chunkBoundary), chunkBoundaryText);

  const appendSeparatorFile = join(sessionsDir, "append-unicode-separators.jsonl");
  const appendSeparators = SessionManager.create(root, sessionsDir);
  appendSeparators.newSession({ id: "append-separators" });
  appendSeparators.setSessionFile(appendSeparatorFile);
  await appendSeparators.flush();
  appendSeparators.appendMessage({
    role: "user",
    content: [{ type: "text", text: unicodeSeparatorText }],
    timestamp: Date.now(),
  } as never);
  await appendSeparators.close();
  const appendSeparatorContent = await readFile(appendSeparatorFile, "utf-8");
  assert.equal(appendSeparatorContent.includes("\u2028"), false);
  assert.equal(appendSeparatorContent.includes("\u2029"), false);
  assert.equal(appendSeparatorContent.includes("\\u2028"), true);
  assert.equal(appendSeparatorContent.includes("\\u2029"), true);
  assert.equal(firstMessageText(await SessionManager.open(appendSeparatorFile, sessionsDir)), unicodeSeparatorText);

  const rewriteSeparatorFile = join(sessionsDir, "rewrite-unicode-separators.jsonl");
  const rewriteSeparators = SessionManager.create(root, sessionsDir);
  rewriteSeparators.newSession({ id: "rewrite-separators" });
  rewriteSeparators.appendMessage({
    role: "user",
    content: [{ type: "text", text: unicodeSeparatorText }],
    timestamp: Date.now(),
  } as never);
  rewriteSeparators.setSessionFile(rewriteSeparatorFile);
  await rewriteSeparators.close();
  const rewriteSeparatorContent = await readFile(rewriteSeparatorFile, "utf-8");
  assert.equal(rewriteSeparatorContent.includes("\u2028"), false);
  assert.equal(rewriteSeparatorContent.includes("\u2029"), false);
  assert.equal(firstMessageText(await SessionManager.open(rewriteSeparatorFile, sessionsDir)), unicodeSeparatorText);

  const separatorBranchFile = join(sessionsDir, "branch-unicode-separators.jsonl");
  await rewriteSeparators.createBranchedSession(rewriteSeparators.getBranchEntries().at(-1)?.id ?? "", {
    id: "branch-separators",
    filePath: separatorBranchFile,
  });
  const separatorBranchContent = await readFile(separatorBranchFile, "utf-8");
  assert.equal(separatorBranchContent.includes("\u2028"), false);
  assert.equal(separatorBranchContent.includes("\u2029"), false);
  assert.equal(firstMessageText(await SessionManager.open(separatorBranchFile, sessionsDir)), unicodeSeparatorText);

  const branchedSessionFile = join(sessionsDir, "branched.jsonl");
  await writeFile(branchedSessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "branched", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "root", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "root" }], timestamp: Date.now(), meta: { messageId: "root-message" } } }),
    JSON.stringify({ type: "message", id: "side", parentId: "root", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "side" }], timestamp: Date.now(), meta: { messageId: "side-message" } } }),
    JSON.stringify({ type: "message", id: "main", parentId: "root", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "main" }], timestamp: Date.now() } }),
    "",
  ].join("\n"));

  const branched = await SessionManager.open(branchedSessionFile, sessionsDir);
  assert.deepEqual(branched.getSessionAffinity(), { sessionId: "branched", threadId: "branched" });
  assert.equal(branched.hasUserMessage("root-message"), true);
  assert.equal(branched.hasUserMessage("side-message"), false);

  const recoverableFile = join(sessionsDir, "recoverable.jsonl");
  const recoverableContent = [
    JSON.stringify({ type: "session", version: 3, id: "recoverable", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "valid", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "valid" }], timestamp: Date.now() } }),
    '{"type":"message"',
  ].join("\n");
  await writeFile(recoverableFile, recoverableContent);
  await assert.rejects(() => SessionManager.open(recoverableFile, sessionsDir), /Invalid session JSONL/);

  const recovered = await SessionManager.open(recoverableFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(recovered.getEntries().length, 1);
  assert.equal((await readFile(recoverableFile, "utf-8")).endsWith("\n"), true);
  const recoveryArchives = await readdir(join(sessionsDir, "archives", "recovery"));
  assert.equal(recoveryArchives.length, 1);
  assert.equal(
    await readFile(join(sessionsDir, "archives", "recovery", recoveryArchives[0] as string), "utf-8"),
    recoverableContent,
  );

  const missingNewlineFile = join(sessionsDir, "missing-newline.jsonl");
  const missingNewlineContent = recoverableContent.slice(0, recoverableContent.lastIndexOf("\n"));
  await writeFile(missingNewlineFile, missingNewlineContent);
  await SessionManager.open(missingNewlineFile, sessionsDir, { recoverTrailingPartial: true });
  assert.equal(await readFile(missingNewlineFile, "utf-8"), `${missingNewlineContent}\n`);

  const noHeaderFile = join(sessionsDir, "no-header.jsonl");
  const noHeaderContent = `${JSON.stringify({ type: "message", id: "orphan" })}\n{"type":"message"`;
  await writeFile(noHeaderFile, noHeaderContent);
  await assert.rejects(
    () => SessionManager.open(noHeaderFile, sessionsDir, { recoverTrailingPartial: true }),
    /Invalid session JSONL/,
  );
  assert.equal(await readFile(noHeaderFile, "utf-8"), noHeaderContent);

  const terminatedBadFile = join(sessionsDir, "terminated-bad.jsonl");
  await writeFile(terminatedBadFile, `${recoverableContent.slice(0, recoverableContent.lastIndexOf("\n"))}\nnot-json\n`);
  await assert.rejects(
    () => SessionManager.open(terminatedBadFile, sessionsDir, { recoverTrailingPartial: true }),
    /Invalid session JSONL/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
