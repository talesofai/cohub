import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { SessionManager } from "../runtime/local-session-manager.js";
import { CohubModelRegistry } from "../runtime/model-registry.js";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-encryption-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const { createCohubAgentSession, isRetryableAssistantFailure, wrapAssistantMessageStream } = await import("../runtime/session-runtime.js");
const { redis } = await import("../redis.js");
redis.on("error", () => undefined);
redis.disconnect();

const modelsConfig: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "TEST_API_KEY",
      models: [{ id: "plain", reasoning: false }],
    },
  },
};

const modelRegistry = new CohubModelRegistry({ configs: [modelsConfig] });
const emptyUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type MockOutcome = { error: string } | { text: string } | { thinking: string };

function createAssistantMessage(outcome: MockOutcome): AssistantMessage {
  const failed = "error" in outcome;
  const content = failed
    ? []
    : "thinking" in outcome
      ? [{ type: "thinking" as const, thinking: outcome.thinking }]
      : [{ type: "text" as const, text: outcome.text }];
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test",
    model: "plain",
    usage: emptyUsage,
    stopReason: failed ? "error" : "stop",
    ...(failed ? { errorMessage: outcome.error } : {}),
    timestamp: Date.now(),
  };
}

function createMockStream(outcomes: MockOutcome[], calls: { count: number }): StreamFn {
  return (_model: Model<Api>, _context: Context) => {
    const outcome = outcomes[Math.min(calls.count, outcomes.length - 1)];
    if (!outcome) throw new Error("Mock stream requires at least one outcome");
    calls.count += 1;
    const message = createAssistantMessage(outcome);
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      if (message.stopReason === "error") {
        stream.push({ type: "error", reason: "error", error: message });
        return;
      }
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });

    return stream;
  };
}

async function withSession(
  outcomes: MockOutcome[],
  run: (input: {
    session: Awaited<ReturnType<typeof createCohubAgentSession>>["session"];
    sessionManager: SessionManager;
    calls: { count: number };
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cohub-agent-retry-"));
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionManager.newSession({ id: "test-session" });
  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    modelRegistry,
    sessionManager,
    tools: [] as AgentTool[],
  });
  const calls = { count: 0 };
  session.agent.streamFunction = createMockStream(outcomes, calls);

  try {
    await run({ session, sessionManager, calls });
  } finally {
    session.dispose();
    await sessionManager.close();
    await rm(root, { recursive: true, force: true });
  }
}

const retryableMessages = [
  'OpenAI API error (500): {"message":"upstream request failed"}',
  '500: {"message":"upstream request failed"}',
  '500 {"error":{"message":"upstream request failed"}}',
  "HTTP 502 Bad Gateway",
  "502 Bad Gateway",
  "<html><head><title>502 Bad Gateway</title></head></html>",
  "Request failed with status 502",
  "status 503: upstream model unavailable",
  "status_code=520 upstream gateway failure",
  "Error Code: 502",
  'Error response: {"error":{"message":"gateway failure","status":502}}',
  "opaque provider wrapper: retry attempt failed with code 507",
  "Error Code 429: Too Many Requests",
  "socket connection was closed",
  "WebSocket closed unexpectedly",
  "Anthropic stream ended before message_stop",
  "OpenAI Responses stream ended before a terminal response event",
  "Upstream service temporarily unavailable",
  "stream_read_error",
  "upstream_error: Upstream request failed",
  "400 upstream_error: Upstream request failed",
  '400: {"message":"upstream response failed: status=400, method=POST, model=grok-4.5, input=media","type":"bad_response_status_code","code":"bad_response_status_code","metadata":{"origin":"upstream","stage":"upstream_response","upstream_status_code":400}}',
  "You can retry your request",
  "ResourceExhausted",
];
for (const errorMessage of retryableMessages) {
  assert.equal(isRetryableAssistantFailure(createAssistantMessage({ error: errorMessage })), true, errorMessage);
}
for (const errorMessage of [
  "429 insufficient_quota",
  "403 insufficient_user_quota: remaining quota 500 credits",
  "429 billing quota exceeded",
  "400 Invalid URL containing value 500",
  "400 Bad Request",
  '400: {"message":"invalid request","type":"invalid_request_error"}',
  "insufficient quota: remaining 500 credits",
  "invalid request: max_tokens must be <= 500",
  "当前可用额度不足，请充值，最低充值金额为 500 元",
  'OpenAI API error (429): {"error":{"message":"Insufficient quota","type":"insufficient_user_quota"}}',
  '429: {"message":"用户额度不足","code":"insufficient_user_quota"}',
]) {
  assert.equal(isRetryableAssistantFailure(createAssistantMessage({ error: errorMessage })), false, errorMessage);
}
assert.equal(
  isRetryableAssistantFailure(createAssistantMessage({ thinking: "unfinished reasoning" })),
  true,
  "thinking-only completion must be continued",
);
assert.equal(
  isRetryableAssistantFailure({
    ...createAssistantMessage({ text: "" }),
    content: [{ type: "text", text: "   " }],
  }),
  true,
  "empty text blocks must be continued",
);

async function* createThrowingPartialStream(): AsyncGenerator<import("@earendil-works/pi-ai").AssistantMessageEvent> {
  const partial: AssistantMessage = {
    ...createAssistantMessage({ text: "partial response" }),
    responseId: "response-1",
    usage: {
      ...emptyUsage,
      input: 12,
      output: 3,
      totalTokens: 15,
    },
  };
  yield { type: "start", partial };
  yield { type: "text_delta", contentIndex: 0, delta: "partial response", partial };
  throw new Error("socket connection was closed");
}

let failureCalls = 0;
const wrappedFailure = wrapAssistantMessageStream(createThrowingPartialStream(), {
  model: modelRegistry.find("test", "plain") as Model<Api>,
  onFailure: () => {
    failureCalls += 1;
  },
});
const failureResult = await wrappedFailure.result();
assert.equal(failureCalls, 1);
assert.equal(failureResult.stopReason, "error");
assert.equal(failureResult.errorMessage, "socket connection was closed");
assert.deepEqual(failureResult.content, [{ type: "text", text: "partial response" }]);
assert.equal(failureResult.usage.totalTokens, 15);
assert.equal(failureResult.responseId, "response-1");

await withSession(
  [{ error: "WebSocket closed unexpectedly" }, { text: "recovered" }],
  async ({ session, sessionManager, calls }) => {
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() } as AgentMessage,
    ]);
    assert.equal(calls.count, 2);
    const assistants = sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.deepEqual(assistants[0]?.content, [{ type: "text", text: "recovered" }]);
  },
);

await withSession(
  [{ thinking: "unfinished reasoning" }, { text: "continued result" }],
  async ({ session, sessionManager, calls }) => {
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "continue incomplete reasoning" }], timestamp: Date.now() } as AgentMessage,
    ]);
    assert.equal(calls.count, 2);
    const assistants = sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.deepEqual(assistants[0]?.content, [{ type: "text", text: "continued result" }]);
  },
);

await withSession(
  [{ error: "429 insufficient_quota" }],
  async ({ session, sessionManager, calls }) => {
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "quota" }], timestamp: Date.now() } as AgentMessage,
    ]);
    assert.equal(calls.count, 1);
    const assistants = sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal((assistants[0] as AssistantMessage | undefined)?.stopReason, "error");
  },
);

await withSession(
  [{ error: "ResourceExhausted" }],
  async ({ session, sessionManager, calls }) => {
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "exhaust" }], timestamp: Date.now() } as AgentMessage,
    ]);
    assert.equal(calls.count, 3);
    const assistants = sessionManager.buildSessionContext().messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1, "only the final exhausted error should be persisted");
    assert.equal((assistants[0] as AssistantMessage | undefined)?.errorMessage, "ResourceExhausted");
  },
);

console.log("session retry checks passed");
process.exit(0);
