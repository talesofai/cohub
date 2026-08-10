import assert from "node:assert/strict";
import { test } from "node:test";
import type { CohubHttpClient, WorkViewStatsResponse } from "@neta-art/cohub";
import { Command } from "commander";
import { registerWorks, getWorkStatsByRef } from "../src/commands/works.js";

const stats: WorkViewStatsResponse = {
  summary: { totalViews: 42, views24h: 8, views7d: 21, views30d: 42 },
  daily: [],
  sources: [
    { source: "web", views: 30 },
    { source: "cli", views: 8 },
    { source: "api", views: 4 },
  ],
};

test("works command registers stats", () => {
  const program = new Command("cohub");
  registerWorks(program);
  const works = program.commands.find((command) => command.name() === "works");
  assert.match(works?.helpInformation() ?? "", /stats \[options\] <work>/);
});

test("getWorkStatsByRef resolves public references before requesting stats", async () => {
  const calls: string[] = [];
  const client = {
    works: {
      getBySlug: async (username: string, spaceSlug: string, workSlug: string) => {
        calls.push(`resolve:${username}/${spaceSlug}/${workSlug}`);
        return { work: { id: "work-1" } };
      },
      getStats: async (workId: string) => {
        calls.push(`stats:${workId}`);
        return stats;
      },
    },
  } as unknown as CohubHttpClient;

  assert.equal(await getWorkStatsByRef(client, "alice/studio/launch"), stats);
  assert.deepEqual(calls, ["resolve:alice/studio/launch", "stats:work-1"]);
});

test("getWorkStatsByRef requests stats directly for work ids", async () => {
  const calls: string[] = [];
  const client = {
    works: {
      get: async () => {
        throw new Error("work details should not be requested");
      },
      getStats: async (workId: string) => {
        calls.push(`stats:${workId}`);
        return stats;
      },
    },
  } as unknown as CohubHttpClient;
  const workId = "123e4567-e89b-42d3-a456-426614174000";

  assert.equal(await getWorkStatsByRef(client, workId), stats);
  assert.deepEqual(calls, [`stats:${workId}`]);
});
