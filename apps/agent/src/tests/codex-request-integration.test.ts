import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { resolveModelRequestHeaders } from "@cohub/infra/config-runtime/models";
import {
  withCodexClientMetadata,
  withCodexRequestHeaders,
  type CodexRequestContext,
} from "../runtime/codex-request.js";

test("sends Codex identity and active prompt-cache metadata on the wire", async () => {
  let resolveRequest!: (request: {
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
  }) => void;
  const requestReceived = new Promise<{
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
  }>((resolve) => {
    resolveRequest = resolve;
  });

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    resolveRequest({
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      headers: request.headers,
    });
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "test response" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const model: Model<Api> = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "cohub",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
    const codexContext: CodexRequestContext = {
      installationId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
      windowId: "session-1:0",
      turnId: "turn-1",
      turnStartedAtUnixMs: 1234,
    };
    const headers = withCodexRequestHeaders(
      resolveModelRequestHeaders(model, undefined),
      codexContext,
    );
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1234 }],
    };

    const stream = openAIResponsesApi().streamSimple(model, context, {
      apiKey: "test-key",
      sessionId: codexContext.sessionId,
      headers,
      onPayload: (payload) => withCodexClientMetadata(payload, codexContext),
    });
    for await (const _event of stream) {
      // The mock returns an error response after recording the request.
    }

    const captured = await requestReceived;
    assert.equal(captured.headers["user-agent"], "codex_cli_rs/0.144.0");
    assert.equal(captured.headers.originator, "codex_cli_rs");
    assert.equal(captured.headers["session-id"], "session-1");
    assert.equal(captured.headers["thread-id"], "session-1");
    assert.equal(captured.headers["x-client-request-id"], "session-1");
    assert.equal(captured.body.prompt_cache_key, "session-1");
    assert.equal(captured.body.prompt_cache_retention, undefined);

    const clientMetadata = captured.body.client_metadata as Record<string, unknown>;
    assert.equal(clientMetadata["x-codex-installation-id"], codexContext.installationId);
    assert.equal(clientMetadata.session_id, "session-1");
    assert.equal(clientMetadata.thread_id, "session-1");
    assert.equal(clientMetadata.turn_id, "turn-1");
    const turnMetadata = JSON.parse(String(clientMetadata["x-codex-turn-metadata"]));
    assert.equal(turnMetadata.installation_id, codexContext.installationId);
  } finally {
    server.close();
    await once(server, "close");
  }
});
