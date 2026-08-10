import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UI_COMMAND_MAX_TIMEOUT_MS } from "@cohub/protocol/ui-command";
import { UiCommandsApi } from "../src/apis/ui-commands.js";
import type { HttpTransport } from "../src/transport.js";

const terminalRecord = {
  version: 1 as const,
  commandId: "cmd-1",
  status: "applied" as const,
  command: {
    type: "preview.show" as const,
    preview: {
      kind: "work" as const,
      workId: "123e4567-e89b-42d3-a456-426614174000",
    },
  },
  actorUserId: "user-1",
  targetClientId: "client-1",
  source: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  settledAt: "2026-01-01T00:00:01.000Z",
};

const createApi = () => {
  let requests = 0;
  const transport = {
    async request() {
      requests += 1;
      return { command: terminalRecord };
    },
  } as unknown as HttpTransport;
  return { api: new UiCommandsApi(transport), requests: () => requests };
};

describe("UiCommandsApi.wait", () => {
  it("accepts the maximum wait duration", async () => {
    const { api, requests } = createApi();
    const result = await api.wait("cmd-1", { timeoutMs: UI_COMMAND_MAX_TIMEOUT_MS });

    assert.equal(result.status, "applied");
    assert.equal(requests(), 1);
  });

  for (const timeoutMs of [0, -1, UI_COMMAND_MAX_TIMEOUT_MS + 1, Number.POSITIVE_INFINITY]) {
    it(`rejects an invalid timeout of ${timeoutMs}`, async () => {
      const { api, requests } = createApi();

      await assert.rejects(() => api.wait("cmd-1", { timeoutMs }), RangeError);
      assert.equal(requests(), 0);
    });
  }
});
