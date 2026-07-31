import assert from "node:assert/strict";
import { test } from "node:test";
import { getMergeableFollowupPrefix } from "../followup-batch.js";

const turn = (
  id: string,
  systemInstructions?: string | null,
  options: {
    userUuid?: string;
    meta?: Record<string, unknown>;
  } = {},
) => ({
  id,
  userUuid: options.userUuid ?? "user-1",
  meta: {
    userId: options.userUuid ?? "user-1",
    ...(systemInstructions == null ? {} : { systemInstructions }),
    ...options.meta,
  },
});

test("followup batches claim the longest compatible prefix", () => {
  const queued = [turn("1", "A"), turn("2", "A"), turn("3", "B"), turn("4", "A")];
  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(2)).map(({ id }) => id), ["3"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(3)).map(({ id }) => id), ["4"]);
});

test("followup batches keep null and explicit instructions isolated", () => {
  const queued = [turn("1"), turn("2", "  "), turn("3", "B"), turn("4", "B")];
  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1", "2"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(2)).map(({ id }) => id), ["3", "4"]);
});

test("empty followup queues have no mergeable prefix", () => {
  assert.deepEqual(getMergeableFollowupPrefix([]), []);
});

test("followup batches never cross actor or delegated authorization boundaries", () => {
  const auth = (scopes: string[]) => ({
    kind: "public_api",
    auth: {
      type: "delegated_prompt",
      actorUserId: "user-1",
      spaceId: "space-1",
      scopes,
      exp: 4_000_000_000,
    },
  });
  const queued = [
    turn("1", "A", { meta: { context: auth(["space.read"]) } }),
    turn("2", "A", { userUuid: "user-2", meta: { context: auth(["space.read"]) } }),
    turn("3", "A", { meta: { context: auth(["space.read", "space.write"]) } }),
  ];

  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1"]);
  assert.deepEqual(getMergeableFollowupPrefix(queued.slice(1)).map(({ id }) => id), ["2"]);
});

test("followup batches ignore websocket tracing identity", () => {
  const context = (requestId: string, connectionId: string) => ({
    kind: "websocket",
    requestId,
    connectionId,
    auth: {
      type: "delegated_prompt",
      source: "work_session",
      actorUserId: "user-1",
      spaceId: "space-1",
      scopes: ["space.read"],
      exp: 4_000_000_000,
      delegatedAt: requestId,
    },
  });
  const queued = [
    turn("1", "A", { meta: { context: context("request-1", "connection-1") } }),
    turn("2", "A", { meta: { context: context("request-2", "connection-2") } }),
  ];

  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1", "2"]);
});

test("followup batches keep space hook environments isolated", () => {
  const queued = [
    turn("1", "A", { meta: { context: { kind: "space_hook", env: { COHUB_HOOK_EVENT: "one" } } } }),
    turn("2", "A", { meta: { context: { kind: "space_hook", env: { COHUB_HOOK_EVENT: "two" } } } }),
  ];

  assert.deepEqual(getMergeableFollowupPrefix(queued).map(({ id }) => id), ["1"]);
});

test("followup batches keep runtime model and tool configuration isolated", () => {
  const first = turn("1", "A", {
    meta: {
      model: "model-a",
      provider: "provider-a",
      accessMode: "full_access",
      env: { API_MODE: "one" },
    },
  });
  const variants = [
    turn("model", "A", { meta: { model: "model-b", provider: "provider-a", accessMode: "full_access", env: { API_MODE: "one" } } }),
    turn("access", "A", { meta: { model: "model-a", provider: "provider-a", accessMode: "read_only", env: { API_MODE: "one" } } }),
    turn("env", "A", { meta: { model: "model-a", provider: "provider-a", accessMode: "full_access", env: { API_MODE: "two" } } }),
  ];

  for (const variant of variants) {
    assert.deepEqual(getMergeableFollowupPrefix([first, variant]).map(({ id }) => id), ["1"]);
  }
});
