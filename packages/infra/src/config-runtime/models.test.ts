import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_ORIGINATOR,
  GPT_RESPONSES_USER_AGENT,
  resolveModelRequestHeaders,
} from "./models.js";

test("adds the Codex CLI user agent to GPT Responses requests", () => {
  assert.deepEqual(
    resolveModelRequestHeaders(
      { api: "openai-responses", id: "gpt-5.4" },
      { "X-Trace-Id": "trace-1" },
    ),
    {
      "X-Trace-Id": "trace-1",
      "User-Agent": GPT_RESPONSES_USER_AGENT,
      Originator: CODEX_ORIGINATOR,
    },
  );
});

test("preserves explicitly configured client identity headers", () => {
  const configured = {
    "user-agent": "custom-client/1.0",
    originator: "custom-originator",
  };
  assert.equal(
    resolveModelRequestHeaders(
      { api: "openai-responses", id: "gpt-5.4" },
      configured,
    ),
    configured,
  );
});

test("does not change non-GPT or non-Responses requests", () => {
  assert.equal(
    resolveModelRequestHeaders(
      { api: "openai-responses", id: "o3" },
      undefined,
    ),
    undefined,
  );
  assert.equal(
    resolveModelRequestHeaders(
      { api: "openai-completions", id: "gpt-4o" },
      undefined,
    ),
    undefined,
  );
});
