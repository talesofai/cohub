import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeCronJobIdentity } from "./cron-job-identity.js";

describe("cron job identity writes", () => {
  it("replaces a stored legacy UUID before DB and repeat payload writes", () => {
    const result = canonicalizeCronJobIdentity({
      id: "cron-1",
      userUuid: "5d4ac7d3-1f50-4af4-8d75-6df54d5edc6a",
      payload: { prompt: "hello" },
    }, "logto-user");

    assert.deepEqual(result, {
      id: "cron-1",
      userUuid: "logto-user",
      payload: { prompt: "hello" },
    });
  });
});
