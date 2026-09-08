import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppEmbedAttach,
  buildAppEmbedCloseRequest,
  buildAppEmbedShellChanged,
  parseAppEmbedAttach,
  parseAppEmbedAttachRequest,
  parseAppEmbedCloseRequest,
  parseAppEmbedShell,
  parseAppEmbedShellChanged,
} from "./src/app-embed.js";

const APP_ID = "123e4567-e89b-42d3-a456-426614174000";
const SPACE_ID = "223e4567-e89b-42d3-a456-426614174000";
const SESSION_ID = "323e4567-e89b-42d3-a456-426614174000";

test("attach round-trips the embedder and shell", () => {
  const message = parseAppEmbedAttach(
    buildAppEmbedAttach({
      embedId: "embed-1",
      embedder: { appId: APP_ID },
      shell: { space: { id: SPACE_ID, name: "Studio" }, session: { id: SESSION_ID }, turn: null },
    }),
  );
  assert.deepEqual(message, {
    protocol: "cohub.app.embed",
    version: 1,
    type: "attach",
    embedId: "embed-1",
    embedder: { appId: APP_ID },
    shell: { space: { id: SPACE_ID, name: "Studio" }, session: { id: SESSION_ID }, turn: null },
  });
});

test("attach rejects a malformed embedder or shell", () => {
  const base = { protocol: "cohub.app.embed", version: 1, type: "attach", embedId: "e" };
  assert.equal(parseAppEmbedAttach({ ...base, embedder: { appId: "nope" }, shell: null }), null);
  assert.equal(parseAppEmbedAttach({ ...base, embedder: { appId: APP_ID }, shell: { space: { id: "x" } } }), null);
  assert.equal(parseAppEmbedAttach({ ...base, embedder: { appId: APP_ID }, shell: "space" }), null);
  assert.equal(parseAppEmbedAttach({ ...base, embedder: { appId: APP_ID }, shell: null })?.shell, null);
});

test("shell hints tolerate a missing shell and drop oversized names", () => {
  assert.equal(parseAppEmbedShell(null), null);
  assert.equal(parseAppEmbedShell(undefined), undefined);
  assert.deepEqual(parseAppEmbedShell({ space: null, session: null, turn: null }), {
    space: null,
    session: null,
    turn: null,
  });
  assert.deepEqual(
    parseAppEmbedShell({ space: { id: SPACE_ID, name: "x".repeat(300) }, session: null, turn: null }),
    { space: { id: SPACE_ID, name: null }, session: null, turn: null },
  );
  assert.equal(parseAppEmbedShell({ space: { id: SPACE_ID } }), undefined);
});

test("shell hints keep the Space → Session → Turn hierarchy", () => {
  assert.equal(parseAppEmbedShell({ space: null, session: { id: SESSION_ID }, turn: null }), undefined);
  assert.equal(
    parseAppEmbedShell({ space: { id: SPACE_ID }, session: null, turn: { id: SESSION_ID } }),
    undefined,
  );
  assert.deepEqual(
    parseAppEmbedShell({ space: { id: SPACE_ID }, session: { id: SESSION_ID }, turn: { id: SESSION_ID } }),
    { space: { id: SPACE_ID, name: null }, session: { id: SESSION_ID }, turn: { id: SESSION_ID } },
  );
});

test("shell.changed and close.request carry the embed id", () => {
  assert.deepEqual(
    parseAppEmbedShellChanged(buildAppEmbedShellChanged({ embedId: "embed-1", shell: null })),
    { protocol: "cohub.app.embed", version: 1, type: "shell.changed", embedId: "embed-1", shell: null },
  );
  assert.deepEqual(parseAppEmbedCloseRequest(buildAppEmbedCloseRequest("embed-1")), {
    protocol: "cohub.app.embed",
    version: 1,
    type: "close.request",
    embedId: "embed-1",
  });
  assert.equal(parseAppEmbedCloseRequest({ protocol: "cohub.app.embed", version: 1, type: "close.request" }), null);
});

test("a missing shell is rejected rather than read as null", () => {
  const base = { protocol: "cohub.app.embed", version: 1, embedId: "embed-1" };
  assert.equal(parseAppEmbedShellChanged({ ...base, type: "shell.changed" }), null);
  assert.equal(parseAppEmbedAttach({ ...base, type: "attach", embedder: { appId: APP_ID } }), null);
});

test("attach.request is a bare envelope", () => {
  assert.ok(parseAppEmbedAttachRequest({ protocol: "cohub.app.embed", version: 1, type: "attach.request" }));
  assert.equal(parseAppEmbedAttachRequest({ protocol: "cohub.app.embed", version: 2, type: "attach.request" }), null);
});
