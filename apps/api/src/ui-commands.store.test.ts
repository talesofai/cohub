import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UI_COMMAND_PENDING_TTL_SECONDS,
  UI_COMMAND_TERMINAL_TTL_SECONDS,
} from "@cohub/protocol/ui-command";
import {
  claimUiCommand,
  getUiCommandKey,
  settleUiCommandRecord,
  UiCommandStoreError,
  type UiCommandStoreClient,
} from "./ui-commands.store.js";

const CLIENT_A = "aaaaaaaabbbbbbbbcccccccc";
const CLIENT_B = "ddddddddeeeeeeeeffffffff";

const record = (overrides: Record<string, unknown> = {}) =>
  ({
    version: 1,
    commandId: "cmd-1",
    status: "pending",
    command: { type: "preview.show", preview: { kind: "work", workId: "w-1" } },
    actorUserId: "user-1",
    targetClientId: CLIENT_A,
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: null,
    ...overrides,
  }) as never;

/** Reads inside `eval`, like Redis, so an interleaved write is observed the same. */
function createFakeRedis(seed?: Record<string, unknown>) {
  const store = new Map<string, string>();
  const appliedTtls: string[] = [];
  for (const [id, value] of Object.entries(seed ?? {})) {
    store.set(getUiCommandKey(id), JSON.stringify(value));
  }

  const client: UiCommandStoreClient = {
    async get(key) {
      return store.get(key) ?? null;
    },
    async eval(_script, _keyCount, ...args) {
      const [key = "", ...rest] = args as string[];
      const raw = store.get(key) ?? null;

      // Claim takes two args after the key; settle takes four.
      if (rest.length === 2) {
        if (raw) return [0, raw];
        store.set(key, rest[0] ?? "");
        appliedTtls.push(rest[1] ?? "");
        return [1, rest[0]];
      }

      const [actorUserId, reportingClientId, next = ""] = rest;
      if (!raw) return [-1, ""];
      const current = JSON.parse(raw) as Record<string, unknown>;
      if (current.actorUserId !== actorUserId) return [-2, ""];
      const target = current.targetClientId as string;
      if (target && target !== reportingClientId) return [-2, ""];
      if (current.settledAt) return [0, raw];
      store.set(key, next);
      appliedTtls.push(rest[3] ?? "");
      return [1, next];
    },
  };

  return { client, store, appliedTtls };
}

const settle = (
  client: UiCommandStoreClient,
  input: { actorUserId?: string; reportingClientId?: string | null; status?: string } = {},
) =>
  settleUiCommandRecord(client, {
    commandId: "cmd-1",
    actorUserId: input.actorUserId ?? "user-1",
    // `null` must stay null: it is the case where provenance was omitted.
    reportingClientId:
      "reportingClientId" in input ? input.reportingClientId ?? null : CLIENT_A,
    next: (current) => ({
      ...current,
      status: (input.status ?? "applied") as never,
      settledAt: "2026-01-01T00:00:05.000Z",
    }),
  });

describe("claimUiCommand", () => {
  it("claims an unused id with the pending lifetime, and a retry sees the winner", async () => {
    const { client, appliedTtls } = createFakeRedis();
    assert.equal((await claimUiCommand(client, record())).claimed, true);

    const retry = await claimUiCommand(client, record({ status: "applied" }));
    assert.equal(retry.claimed, false);
    assert.equal(retry.record.status, "pending", "the stored record wins");
    assert.deepEqual(appliedTtls, [String(UI_COMMAND_PENDING_TTL_SECONDS)]);
  });

  it("uses the terminal lifetime when a command settles during creation", async () => {
    const { client, appliedTtls } = createFakeRedis();
    const terminal = record({
      status: "no_active_client",
      settledAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal((await claimUiCommand(client, terminal)).claimed, true);
    assert.deepEqual(appliedTtls, [String(UI_COMMAND_TERMINAL_TTL_SECONDS)]);
  });
});

describe("a malformed store reply", () => {
  const badClient = (reply: unknown): UiCommandStoreClient => ({
    async get() {
      return JSON.stringify(record());
    },
    async eval() {
      return reply;
    },
  });

  // Failing closed matters: dispatching a command whose record was never
  // persisted would guarantee the caller a timeout.
  for (const [name, reply] of [
    ["an unusable code", "OK"],
    ["a corrupt stored record", [0, "{not json"]],
    ["a lost claim naming no winner", [0, ""]],
  ] as const) {
    it(`rejects ${name} instead of dispatching`, async () => {
      await assert.rejects(
        () => claimUiCommand(badClient(reply), record()),
        UiCommandStoreError,
      );
    });
  }
});

describe("settleUiCommandRecord", () => {
  it("lets the addressed frontend settle and switches to the terminal lifetime", async () => {
    const { client, appliedTtls } = createFakeRedis({ "cmd-1": record() });
    const outcome = await settle(client);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.record.status, "applied");
    assert.deepEqual(appliedTtls, [String(UI_COMMAND_TERMINAL_TTL_SECONDS)]);
  });

  // A missing client id must not be a free pass, or any of the user's own API
  // clients could answer for a command addressed at a browser tab.
  for (const [name, input] of [
    ["another user", { actorUserId: "user-2" }],
    ["a different instance of the same user", { reportingClientId: CLIENT_B }],
    ["a report that omits its client id", { reportingClientId: null }],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const { client } = createFakeRedis({ "cmd-1": record() });
      const outcome = await settle(client, input);

      assert.equal(outcome.ok, false);
      assert.equal(outcome.ok === false && outcome.reason, "forbidden");
    });
  }

  it("settles an untargeted command regardless of reporting client", async () => {
    const { client } = createFakeRedis({ "cmd-1": record({ targetClientId: "" }) });
    assert.equal((await settle(client, { reportingClientId: null })).ok, true);
  });

  it("reports not_found for an expired or unknown command", async () => {
    const outcome = await settle(createFakeRedis().client);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "not_found");
  });

  it("first writer wins, and the loser sees the winning record", async () => {
    // The race the Lua script exists for: both read `pending` before either writes.
    const { client } = createFakeRedis({ "cmd-1": record() });
    const outcomes = await Promise.all([
      settle(client, { status: "applied" }),
      settle(client, { status: "rejected" }),
    ]);

    const won = outcomes.filter((outcome) => outcome.ok);
    const lost = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(won.length, 1, "exactly one report may win");
    assert.equal(lost[0]?.ok === false && lost[0].reason, "already_settled");
    assert.equal(lost[0]?.ok === false && lost[0].record?.status, "applied");
  });
});
