# @neta-art/cohub

Cohub SDK for interacting with spaces, sessions, checkpoints, and realtime agent collaboration.

## Install

```bash
npm install @neta-art/cohub
```

## Quick start

```ts
import { createCohubClient } from "@neta-art/cohub";
import type { ContentBlock } from "@neta-art/cohub";

const client = createCohubClient({
  getAccessToken: async () => localStorage.getItem("token"),
});

const content: ContentBlock[] = [{ type: "text", text: "Hello" }];
```

The SDK connects to production by default:

- API: `https://api.cohub.run`
- WebSocket: `wss://gateway.cohub.run/ws`

Use development with `ENV=dev` in Node.js:

```bash
ENV=dev node app.js
```

Or select it explicitly in code:

```ts
const client = createCohubClient({
  env: "dev",
  getAccessToken: async () => localStorage.getItem("token"),
});
```

Development uses:

- API: `https://api-dev.cohub.run`
- WebSocket: `wss://gateway-dev.cohub.run/ws`

Custom endpoints are still supported when needed:

```ts
const client = createCohubClient({
  baseUrl: "https://api.example.com",
  getAccessToken: async () => localStorage.getItem("token"),
  websocket: {
    url: "https://gateway.example.com",
  },
});
```

## Spaces and sessions

A **Space** is a live, isolated working environment where users and agents create together.

```ts
const created = await client.spaces.create({ name: "Demo" });
const space = client.space(created.space.id);

const sessionResult = await space.sessions.create({ title: "Planning" });
const session = space.session(sessionResult.session.id);

await session.messages.send({
  content: [{ type: "text", text: "Help me plan the next steps" }],
});
```

## Boards

Use `space.boards` for collection operations and bind an ID with
`space.board(boardId)` for entity operations:

```ts
const created = await space.boards.create({
  path: "boards/plan.board",
  title: "Plan",
  nodes: [],
});

const board = space.board(created.board.id);
// Equivalent: space.boards.byId(created.board.id)

const snapshot = await board.inspect({
  include: ["nodes", "effects", "sequences", "clips", "playback"],
});

await board.apply({
  txId: crypto.randomUUID(),
  baseVersion: snapshot.board.version,
  operations: [
    { type: "board.patch", payload: { patch: { title: "Updated plan" } } },
  ],
});

await board.play({
  commandId: crypto.randomUUID(),
  type: "play",
  sequenceId: "ambient",
});
```

A bound `BoardClient` injects its `boardId` into validation and transaction
requests. Realtime subscriptions are also scoped to that Board:

```ts
const stop = board.subscribe({
  transaction(event) {
    console.log("version", event.payload.version);
  },
  playback(event) {
    console.log("playback", event.payload.status);
  },
});

stop();
```

Board is split by dependency: the model runs anywhere, drawing needs PixiJS.
`@neta-art/cohub/board` carries the document schema, geometry, the shape layer,
timeline compilation and export planning, with no renderer and no PixiJS — so
agents, servers and edge workers can read, write and measure boards without a
graphics stack:

```ts
import {
  BoardDocumentSchema,
  clip,
  compileSequence,
  createBoardExtensionRegistry,
  itemBounds,
  planBoardExport,
  timeline,
} from "@neta-art/cohub/board";

const sequence = compileSequence({
  id: "ambient",
  name: "Ambient",
  seed: "ambient-v1",
  timeline: clip({
    kind: "motion.keyframes",
    target: { type: "node", nodeId: "image" },
    duration: 1_000,
    keyframes: [
      { at: 0, value: { y: 0 } },
      { at: 500, value: { y: -8 } },
      { at: 1_000, value: { y: 0 } },
    ],
  }),
});

await space.boards.create({
  path: "boards/ambient.board",
  metadata: {
    playback: {
      sequenceId: sequence.sequence.id,
      delayMs: 500,
      loop: true,
    },
  },
  sequences: [sequence],
});
```

Drawing pixels is where PixiJS enters. The card renderers and themes the editor
uses live behind `@neta-art/cohub/board/render`, and turning a plan into an
image has dedicated browser and Node.js entries:

```ts
import { getBoardCardRenderer } from "@neta-art/cohub/board/render";
import { renderBoardExport } from "@neta-art/cohub/board/export";
import {
  createBoardHeadlessRenderer,
  exportBoardImageBytes,
} from "@neta-art/cohub/board/headless";
```

Install `pixi.js` to use `board/render` or `board/export`, and add
`@napi-rs/canvas` as well for `board/headless`. Both are optional peers, and
`@neta-art/cohub/board` never reaches for either, so HTTP-only installations
stay lightweight.

Text metrics follow the same split. The renderers measure through a real canvas
and set that up themselves, so nothing extra is needed to draw or export. Called
straight off `@neta-art/cohub/board` with no renderer in play,
`measureBoardText` returns a per-character estimate instead — fine for laying
out a board on a server, but call `installBoardTextMeasurement` from
`board/render` first if the numbers have to match what the editor draws.

## Session subscriptions

```ts
const stop = session.subscribe({
  progress(event) {
    console.log("progress", event.payload);
  },
  finalized(event) {
    console.log("done", event.payload);
  },
});

stop();
```

## Works and the Work runtime

A **Work** is a published, shareable web page hosted by Cohub. When a viewer
opens a Work, it runs inside a Cohub-managed runtime that provides short-lived
access tokens — no API keys required.

Three runtime-only APIs are available **exclusively inside a published Work**:

- `client.context()` — returns Work identity, Space identity, and current
  permission scopes. Returns `null` outside a Work runtime.
- `client.auth.request({ scopes, reason })` — shows the viewer a consent dialog
  and caches a token with the approved scopes.
- `client.work.commerce.*` — entitlement checks, credit consumption,
  purchases.

### Quick start (inside a Work)

```ts
// Browsers don't inject ENV — pass it explicitly.
const client = createCohubClient({ env: "prod" });

const ctx = await client.context();
if (!ctx?.space?.id) throw new Error("Not inside a published Work.");

const space = client.space(ctx.space.id);

// Request viewer scopes from a user gesture (button click)
await client.auth.request({
  scopes: ["session.prompt.fullaccess", "generation.create"],
  reason: "This Work needs to send prompts and generate images.",
});
```

### The scope model (critical)

Work permissions come in **two disjoint sets**:

- **Work scopes** (read, no consent): `space.view`, `session.view`,
  `file.view`, `taskrun.view` — granted at publish time.
- **Viewer scopes** (action, consent-required): `session.prompt.fullaccess`,
  `generation.create`, `user.space.list`, `user.session.list`,
  `user.usage.read` — approved per-viewer via `auth.request()`.

> **Space-wide reads need work scopes. Viewer actions and their owner-bound
results need viewer scopes.** A matching `session.prompt.*` grant can poll the
viewer's own session in the current Work Space, while `session.view` is still
required for another user's session. Likewise, `generation.create` can list and
poll only the viewer's own generation tasks; it never exposes other task types.
`taskrun.view` remains required for broader task access. `user.session.list`
lists summaries only and does not grant turn content.

For the complete API-to-scope mapping, initialization recipe, capability
recipes, a full working example, and a pitfalls checklist, see the
**[Work Runtime Guide](./docs/work-runtime-guide.md)**.
