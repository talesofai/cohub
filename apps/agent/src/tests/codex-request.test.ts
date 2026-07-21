import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexTurnStateTracker,
  getCodexTurnState,
  withCodexClientMetadata,
  withCodexRequestHeaders,
  type CodexRequestContext,
} from "../runtime/codex-request.js";

const context: CodexRequestContext = {
  sessionId: "session-1",
  windowId: "session-1:0",
  turnId: "turn-1",
  turnStartedAtUnixMs: 1234,
};

test("adds Cohub session and turn identity to Codex request headers", () => {
  const headers = withCodexRequestHeaders(
    {
      "session-id": "stale-session",
      "X-Trace-Id": "trace-1",
    },
    { ...context, turnState: "sticky-1" },
  );

  assert.equal(headers["Session-Id"], "session-1");
  assert.equal(headers["Thread-Id"], "session-1");
  assert.equal(headers["X-Client-Request-Id"], "session-1");
  assert.equal(headers["X-Codex-Window-Id"], "session-1:0");
  assert.equal(headers["X-Codex-Turn-State"], "sticky-1");
  assert.equal(headers["X-Trace-Id"], "trace-1");
  assert.equal(headers["session-id"], undefined);

  const metadata = JSON.parse(String(headers["X-Codex-Turn-Metadata"]));
  assert.deepEqual(metadata, {
    session_id: "session-1",
    thread_id: "session-1",
    turn_id: "turn-1",
    window_id: "session-1:0",
    request_kind: "turn",
    turn_started_at_unix_ms: 1234,
  });
});

test("merges canonical Codex client metadata into the Responses payload", () => {
  const payload = withCodexClientMetadata(
    {
      model: "gpt-5.4",
      prompt_cache_key: "session-1",
      client_metadata: { custom: "value", session_id: "stale-session" },
    },
    context,
  ) as Record<string, unknown>;

  assert.equal(payload.prompt_cache_key, "session-1");
  assert.deepEqual(payload.client_metadata, {
    custom: "value",
    session_id: "session-1",
    thread_id: "session-1",
    turn_id: "turn-1",
    "x-codex-window-id": "session-1:0",
    "x-codex-turn-metadata": JSON.stringify({
      session_id: "session-1",
      thread_id: "session-1",
      turn_id: "turn-1",
      window_id: "session-1:0",
      request_kind: "turn",
      turn_started_at_unix_ms: 1234,
    }),
  });
});

test("reads sticky turn state case-insensitively", () => {
  assert.equal(
    getCodexTurnState({
      status: 200,
      headers: { "X-Codex-Turn-State": " sticky-1 " },
    }),
    "sticky-1",
  );
});

test("keeps sticky routing state inside one turn", () => {
  let now = 1000;
  const tracker = new CodexTurnStateTracker(() => now);
  assert.deepEqual(tracker.current("turn-1"), {
    turnId: "turn-1",
    turnStartedAtUnixMs: 1000,
  });

  tracker.capture("turn-1", {
    status: 200,
    headers: { "x-codex-turn-state": "sticky-1" },
  });
  assert.equal(tracker.current("turn-1")?.turnState, "sticky-1");

  now = 2000;
  assert.deepEqual(tracker.current("turn-2"), {
    turnId: "turn-2",
    turnStartedAtUnixMs: 2000,
  });
  tracker.capture("turn-1", {
    status: 200,
    headers: { "x-codex-turn-state": "stale-state" },
  });
  assert.equal(tracker.current("turn-2")?.turnState, undefined);
  assert.equal(tracker.current(undefined), undefined);
});
