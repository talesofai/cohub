import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import type { Fetch } from "../src/transport.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("space.runCommand sends immediate commands", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({ mode: "immediate", taskRunId: "task-1" });
  };
  const space = new CohubHttpClient({
    baseUrl: "https://api.example.test",
    fetch,
  }).space("space-1");

  const response = await space.runCommand({ command: "git status" });

  assert.deepEqual(response, { mode: "immediate", taskRunId: "task-1" });
  assert.equal(requests[0]?.url, "https://api.example.test/api/spaces/space-1/commands");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    command: "git status",
  });
});

test("space.runCommand sends recurring command schedules", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      mode: "repeat",
      cronJobId: "cron-1",
      nextRunAt: "2026-08-14T00:05:00.000Z",
      timezone: "UTC",
    });
  };
  const space = new CohubHttpClient({
    baseUrl: "https://api.example.test",
    fetch,
  }).space("space-1");

  const response = await space.runCommand({
    command: "./reconcile.sh",
    title: "bot-agent service reconcile",
    schedule: {
      mode: "repeat",
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    },
  });

  assert.equal(response.mode, "repeat");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    command: "./reconcile.sh",
    title: "bot-agent service reconcile",
    schedule: {
      mode: "repeat",
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    },
  });
});
