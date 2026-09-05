import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";

test("space turns list forwards stable filters and cursors", async () => {
  let requestUrl = "";
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        turns: [],
        snapshotAt: "2026-07-31T08:00:00.000Z",
        snapshotCursor: "snapshot",
        pageInfo: { hasMore: false, nextCursor: null },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.space("space-1").turns.list({
    author: "others",
    after: "after-cursor",
    before: "2026-07-31T08:00:00.000Z",
    cursor: "page-cursor",
    limit: 6,
    sessionId: "session-1",
  });

  assert.equal(
    requestUrl,
    "https://api.example.test/api/spaces/space-1/turns?author=others&after=after-cursor&before=2026-07-31T08%3A00%3A00.000Z&cursor=page-cursor&limit=6&sessionId=session-1",
  );
});

test("session turn intermediate reads the CDN archive through signed URLs", async () => {
  const requests: string[] = [];
  const objectKey = "spaces/space-1/sessions/session-1/turns/turn-1/intermediate/messages.json";
  const client = createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ urls: { [objectKey]: "https://cdn.example.test/messages.json" } }), { status: 200 });
    },
  });
  const archive = await client.space("space-1").session("session-1").turns.intermediate.get("turn-1", objectKey, {
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes("signed-urls")) {
        return new Response(JSON.stringify({ urls: { [objectKey]: "https://cdn.example.test/messages.json" } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        version: 1,
        spaceId: "space-1",
        sessionId: "session-1",
        turnId: "turn-1",
        summary: { messageCount: 1, toolCallCount: 0 },
        messages: [],
      }), { status: 200 });
    },
  });

  assert.equal(archive?.turnId, "turn-1");
  assert.deepEqual(requests, [
    "https://api.example.test/api/sessions/session-1/turns/turn-1/signed-urls",
    "https://cdn.example.test/messages.json",
  ]);
});
