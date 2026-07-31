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
