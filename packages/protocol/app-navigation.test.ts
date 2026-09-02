import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppNavigationOpenMessage,
  parseAppNavigationOpenMessage,
  parseAppNavigationOpenResponse,
} from "./src/app-navigation.js";

const APP_ID = "123e4567-e89b-42d3-a456-426614174000";
const SPACE_ID = "223e4567-e89b-42d3-a456-426614174000";

test("parses App navigation with an optional call", () => {
  const message = parseAppNavigationOpenMessage(
    buildAppNavigationOpenMessage({
      requestId: "request-1",
      target: {
        kind: "app",
        ref: `https://cohub.live/alice/studio/demo?view=board#today`,
      },
      call: { method: "selection.get", input: { hidden: false } },
    }),
  );

  assert.deepEqual(message?.target, {
    kind: "app",
    ref: "https://cohub.live/alice/studio/demo?view=board#today",
  });
  assert.deepEqual(message?.call, {
    method: "selection.get",
    input: { hidden: false },
  });
});

test("accepts File targets with an optional editor position", () => {
  const message = parseAppNavigationOpenMessage({
    protocol: "cohub.app.navigation",
    version: 1,
    type: "open",
    requestId: "request-2",
    target: {
      kind: "file",
      spaceId: SPACE_ID,
      path: "src/main.ts",
      view: { line: 42, column: 5 },
    },
  });
  assert.deepEqual(message?.target, {
    kind: "file",
    spaceId: SPACE_ID,
    path: "src/main.ts",
    view: { line: 42, column: 5 },
  });
});

test("validates navigation response reasons and call results", () => {
  const valid = parseAppNavigationOpenResponse({
    protocol: "cohub.app.navigation",
    version: 1,
    type: "open.result",
    requestId: "request-6",
    handled: true,
    call: { ok: false, code: "method_not_found", message: "Missing method" },
  });
  assert.deepEqual(valid?.call, {
    ok: false,
    code: "method_not_found",
    message: "Missing method",
  });
  for (const value of [
    { reason: "unknown" },
    { call: "invalid" },
    { call: { ok: "yes" } },
    { call: { ok: false, code: "x" } },
    { call: { ok: false, code: "x", message: 1 } },
  ]) {
    assert.equal(
      parseAppNavigationOpenResponse({
        protocol: "cohub.app.navigation",
        version: 1,
        type: "open.result",
        requestId: "request-7",
        handled: true,
        ...value,
      }),
      null,
    );
  }
});

test("rejects malformed or oversized navigation targets", () => {
  assert.equal(
    parseAppNavigationOpenMessage({
      protocol: "cohub.app.navigation",
      version: 1,
      type: "open",
      requestId: "request-4",
      target: { kind: "app", ref: APP_ID.repeat(200) },
    }),
    null,
  );
  assert.equal(
    parseAppNavigationOpenResponse({
      protocol: "cohub.app.navigation",
      version: 1,
      type: "open.result",
      requestId: "request-5",
      handled: "yes",
    }),
    null,
  );
});
