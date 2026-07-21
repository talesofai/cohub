import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../runtime/local-session-manager.js";

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

  const branchedSessionFile = join(sessionsDir, "branched.jsonl");
  await writeFile(branchedSessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "branched", timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: "message", id: "root", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "root" }], timestamp: Date.now(), meta: { messageId: "root-message" } } }),
    JSON.stringify({ type: "message", id: "side", parentId: "root", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "side" }], timestamp: Date.now(), meta: { messageId: "side-message" } } }),
    JSON.stringify({ type: "message", id: "main", parentId: "root", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "main" }], timestamp: Date.now() } }),
    "",
  ].join("\n"));

  const branched = await SessionManager.open(branchedSessionFile, sessionsDir);
  assert.equal(branched.hasUserMessage("root-message"), true);
  assert.equal(branched.hasUserMessage("side-message"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("local session manager checks passed");
