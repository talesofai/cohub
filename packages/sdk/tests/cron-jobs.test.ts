import assert from "node:assert/strict";
import { test } from "node:test";
import { CronJobsApi } from "../src/apis/cron-jobs.js";
import type { HttpTransport } from "../src/transport.js";

test("cron updates send the caller's optimistic concurrency version", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport = {
    request: async (path: string, init: RequestInit) => {
      requests.push({
        path,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return { ok: true, job: {} };
    },
  } as unknown as HttpTransport;
  const api = new CronJobsApi(transport);

  await api.update("cron-1", {
    expectedUpdatedAt: "2026-07-31T12:00:00.000Z",
    title: "Updated title",
  });
  await api.toggle("cron-1", false, "2026-07-31T12:01:00.000Z");

  assert.deepEqual(requests, [
    {
      path: "/api/cron-jobs/cron-1",
      body: {
        expectedUpdatedAt: "2026-07-31T12:00:00.000Z",
        title: "Updated title",
      },
    },
    {
      path: "/api/cron-jobs/cron-1",
      body: {
        enabled: false,
        expectedUpdatedAt: "2026-07-31T12:01:00.000Z",
      },
    },
  ]);
});
