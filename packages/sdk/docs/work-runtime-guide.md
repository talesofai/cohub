# Cohub Work Runtime Guide

This guide explains how to use the Cohub SDK **inside a published Work** — the
only environment where runtime APIs (`context()`, `auth.request`,
`work.commerce.*`, `work.realtime.*`) function. Read this before writing any
Work that calls Cohub capabilities from browser-side JavaScript.

It is written to be self-contained: an agent or developer who reads only this
file plus the SDK type definitions should be able to build a working Work
without reverse-engineering source code.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [Two deployment modes: bridge vs broker](#2-two-deployment-modes-bridge-vs-broker)
3. [The scope model — read this twice](#3-the-scope-model--read-this-twice)
4. [Initialization recipe](#4-initialization-recipe)
5. [Capability reference](#5-capability-reference)
   - [LLM chat](#llm-chat-spaceprompt--subscribegeneration)
   - [Image / media generation](#image--media-generation-generationscreateandwait)
   - [Model listing](#model-listing-modelslist--modelslistmultimodal)
   - [File reads](#file-reads-spacefiles)
   - [Account-level data](#account-level-data-spaceslist--userlistsessions--usergetusage)
   - [Commerce](#commerce-workcommerce)
   - [Realtime rooms](#realtime-rooms-workrealtime)
6. [Complete working example](#6-complete-working-example)
7. [Common pitfalls checklist](#7-common-pitfalls-checklist)
8. [Publishing a Work (API/SDK)](#8-publishing-a-work-apisdk)

---

## 1. Mental model

A **Work** is a published, shareable web page hosted by Cohub. When a viewer
opens a Work, Cohub serves its HTML/JS inside a **runtime** that bridges the
Work's code to Cohub's backend.

From the Work's JavaScript, you create a Cohub client and call APIs the same
way you would from any other client — **but** the client is pre-wired to obtain
short-lived access tokens from the Cohub shell (the runtime host) instead of
requiring the viewer to paste an API key.

```
┌─────────────────────────────────────────┐
│  Cohub shell (host page / iframe parent) │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  Your Work (iframe or standalone) │  │
│  │                                   │  │
│  │  createCohubClient() ──► token ──►│──┼──► Cohub API
│  │  client.context()    ◄── identity │  │
│  │  client.auth.request() ──► consent│  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

Four runtime-only APIs form the foundation; everything else is standard SDK:

| API | What it does | Returns |
|---|---|---|
| `client.context()` | Asks the host for the Work's identity | `{ work, space, viewer?, permissions }` or `null` |
| `client.auth.request({ scopes, reason })` | Shows the viewer a consent dialog; on approval, caches a token carrying those scopes | `true` / `false` |
| `client.work.commerce.*` | Entitlement checks, credit consumption, purchases | (see Commerce section) |
| `client.work.realtime.*` | Temporary rooms, events, presence, and membership | (see Realtime rooms section) |

> **Runtime-only constraint.** These APIs only work inside a **published**
> Work. Outside that context (a static asset URL, a local `file://` preview,
> a plain Node script) `context()` returns `null` and the other runtime APIs
> fail. Always develop against a published Work.

---

## 2. Two deployment modes: bridge vs broker

The SDK auto-detects which mode you are in based on whether the page is inside
an iframe. You normally do **not** need to set the mode explicitly.

### Bridge mode (default, primary)

The Work runs inside a Cohub-hosted iframe (`window.parent !== window`). The
SDK communicates with the parent window via `postMessage` to request tokens
and context. This is the normal case when a viewer opens a Work through Cohub.

- `client.context()` returns the **real** `space.id`, `work.id`, and current
  permission scopes from the host.
- `client.auth.request()` triggers an in-shell consent flow (no popup window).

### Broker mode (standalone deployment)

The Work is accessed as a standalone page (`window.parent === window`), e.g.
a direct static-asset URL not wrapped in the Cohub iframe. The SDK opens a
**popup window** to a Cohub auth-broker page to obtain tokens.

- `client.context()` is **answered locally** by the SDK: `space.id` is an
  **empty string `""`**, and `viewerScopes` is **always empty**.
- `client.auth.request()` opens a popup to
  `${brokerOrigin}/work-auth?work=${workId}`.

> **Broker mode requires configuration.** You must pass `work: { brokerOrigin,
> workId }` — or `work: { brokerOrigin, ownerUsername, spaceSlug, workSlug }`
> when the workId isn't known yet — to `createCohubClient` for broker mode to
> activate. Without it, a standalone page gets `ParentBridgeTransport` which
> has no parent to talk to, so `context()` returns `null`. See
> [Initialization recipe](#4-initialization-recipe).

### Detecting the mode at runtime

```js
const ctx = await client.context();
const isBroker = !ctx?.space?.id; // bridge has a real id; broker is ""
```

In broker mode you cannot get `spaceId` from `context()`. Resolve it via the
public Work API (no token needed):

```js
const isBroker = !ctx?.space?.id;
let spaceId;
if (isBroker) {
  const detail = await client.works.get(workId); // public, no auth
  spaceId = detail.work.spaceId;
} else {
  spaceId = ctx.space.id;
}
```

### Broker mode: user-activation ordering gotcha

`HttpTransport` calls `getAccessToken()` on **every** request — including
public ones like `works.get()`. In broker mode, an uncached token request
opens a popup, which **consumes the browser's user-activation budget**. If a
second popup (`auth.request`) follows in the same click, the browser blocks it.

**Fix:** call `auth.request()` **before** any other API call that triggers
`getAccessToken()`. After `auth.request` succeeds, the token is cached in
`localStorage` and subsequent `getAccessToken()` calls hit the cache — no
popup.

```js
// WRONG: works.get() opens a popup, consumes activation, auth.request popup blocked
const detail = await client.works.get(workId);
await client.auth.request({ scopes, reason });

// RIGHT: auth.request opens the only popup, then works.get() hits token cache
await client.auth.request({ scopes, reason });
const detail = await client.works.get(workId);
```

Bridge mode is unaffected — `getAccessToken()` uses `postMessage` (no popup),
so ordering does not matter there.

---

## 3. The scope model — read this twice

> This is the **single most common source of bugs**. Every 403 you encounter
> in a Work will almost certainly trace back to a missing scope of the wrong
> type. Read this section carefully.

Cohub Work permissions come in **two disjoint sets**. They do not overlap and
do not imply each other.

### Work scopes (direct, no user consent)

Granted by the publisher **at publish time**. The Work always has them — no
viewer action needed. These are **read** permissions.

```
space.view       — read space config, list models
session.view     — read sessions, turns, stream generation updates
file.view        — read files / file tree
taskrun.view     — read task run details (used by generation polling!)
```

Set via `workScopes` when creating/updating a Work.

### Viewer scopes (consent-required, action permissions)

Declared by the publisher at publish time as **allowed** (`allowedViewerScopes`),
but **not active** until the viewer approves them through a consent dialog
triggered by `client.auth.request()`. These are **action** permissions.

```
session.prompt.readonly   — send read-only prompts (no side effects)
session.prompt.fullaccess — send prompts with full access (write, create sessions)
generation.create         — create generation tasks (image/video/audio)
user.space.list           — list the viewer's spaces (account-level)
user.session.list         — list recent sessions the viewer can view as themselves (across spaces)
user.usage.read           — read the viewer's aggregated usage
```

### The golden rule

> **Read operations need work scopes. Action operations need viewer scopes.
> They never substitute for each other.**

`session.prompt.fullaccess` lets you **send** a prompt, but does **not** let
you **read** the result — that needs `session.view` (a work scope).
`generation.create` lets you **create** a generation task, but reading its
result needs `taskrun.view` (a work scope).

### Complete API → scope mapping

| Operation | SDK call | Scope needed | Type |
|---|---|---|---|
| Read space config | `space.get()` / `space.getConfig()` | `space.view` | work |
| List models | `client.models.list()` / `listMultimodal()` | *(none — just authenticated)* | — |
| Send a prompt (full) | `space.prompt({ accessMode: "full_access", content, ... })` | `session.prompt.fullaccess` | viewer |
| Send a prompt (read-only) | `space.prompt({ accessMode: "read_only", content, ... })` | `session.prompt.readonly` | viewer |
| Read turn result | `session.turns.get(turnId)` | `session.view` | work |
| Stream generation | `session.subscribeGeneration({ state, finalized })` | `session.view` | work |
| Read file tree | `space.files.tree()` | `file.view` | work |
| Read file content | `space.files.read(path)` | `file.view` | work |
| Create generation task | `client.generations.create(request)` | `generation.create` | viewer |
| **Poll generation result** | `client.generations.wait(taskRunId)` / `createAndWait()` | **`taskrun.view`** | **work** |
| Read task run detail | `client.tasks.get(taskRunId)` | `taskrun.view` | work |
| List viewer's spaces | `client.spaces.list()` | `user.space.list` | viewer |
| List viewer's sessions | `client.user.listSessions()` | `user.session.list` | viewer |
| Read viewer's usage | `client.user.getUsage()` | `user.usage.read` | viewer |
| Commerce: entitlements | `client.work.commerce.getEntitlements()` | *(runtime only, no scope)* | — |
| Commerce: consume credits | `client.work.commerce.consumeCredits()` | *(runtime only, no scope)* | — |
| Commerce: purchase | `client.work.commerce.purchase()` | *(runtime only, no scope)* | — |
| Realtime rooms | `client.work.realtime.createRoom()` / `joinRoom()` | *(runtime only, no scope)* | — |

### Minimal scope sets for common Work types

**LLM chat Work** (send prompt + read reply):
- workScopes: `["space.view", "session.view"]`
- allowedViewerScopes: `["session.prompt.fullaccess"]`

**Image generation Work** (create + poll):
- workScopes: `["space.view", "taskrun.view"]`
- allowedViewerScopes: `["generation.create"]`

**LLM + image generation Work** (the demo):
- workScopes: `["space.view", "session.view", "taskrun.view"]`
- allowedViewerScopes: `["session.prompt.fullaccess", "generation.create"]`

**File-reader Work** (static, no viewer action):
- workScopes: `["space.view", "file.view"]`
- allowedViewerScopes: `[]`

### Checking granted scopes at runtime

`client.context()` returns a `permissions` object with three arrays:

```js
const ctx = await client.context();
ctx.permissions.scopes       // all effective scopes (work + viewer)
ctx.permissions.workScopes   // work scopes granted at publish time
ctx.permissions.viewerScopes // viewer scopes the current viewer has approved
```

To check whether a **viewer** scope is already granted (to skip re-requesting):

```js
function hasViewerScope(ctx, scope) {
  return (ctx?.permissions?.viewerScopes ?? []).includes(scope);
}
```

---

## 4. Initialization recipe

### No-build HTML (CDN import)

Works are typically single HTML files with no bundler. Import the SDK from an
ESM CDN:

```js
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@latest";
```

`@latest` keeps a Work on the current SDK release. Pin an exact version only
when a deployment needs reproducible dependency updates.

### Environment detection — critical

The SDK defaults to **production**. A Work running on a dev/staging host
(e.g. `dev.cohub.run`, a `/dev/` path prefix) **must** pass `env: "dev"`
explicitly — browsers do not inject `ENV` like Node does. If you omit this,
your Work will call the production API while the runtime host expects dev,
causing silent auth failures.

```js
const isDevWork =
  location.pathname.startsWith("/dev/") ||
  location.hostname.includes("dev");

const client = createCohubClient({
  env: isDevWork ? "dev" : "prod",
});
```

### Broker mode configuration (standalone pages only)

If the Work may be accessed as a standalone page (not inside the Cohub
iframe), pass the `work` option so the SDK can fall back to broker mode:

```js
const client = createCohubClient({
  env: isDevWork ? "dev" : "prod",
  work: {
    brokerOrigin: isDevWork ? "https://dev.cohub.run" : "https://cohub.run",
    workId: "<your-published-work-id>",
  },
});
```

When inside the Cohub iframe, the SDK auto-detects bridge mode and ignores
broker config. When standalone, it uses broker mode. **One codebase, both
deployments.**

#### Broker mode without a pre-known workId

The `workId` is only generated at publish time, so you often cannot hardcode
it while writing the Work. In standalone deployments you can omit `workId` and
instead pass the Work's public **slug triple**. The SDK resolves the workId at
runtime via the public `works.getBySlug` API (anonymous, no auth required),
caches it, and starts broker mode with it.

All three values are known before publishing:

- `workSlug` — the slug you chose when creating the Work.
- `ownerUsername` — the space owner's username (`cohub auth whoami`).
- `spaceSlug` — the space's slug (`cohub spaces get <spaceId>`).

```js
const client = createCohubClient({
  env: isDevWork ? "dev" : "prod",
  work: {
    brokerOrigin: isDevWork ? "https://dev.cohub.run" : "https://cohub.run",
    ownerUsername,
    spaceSlug,
    workSlug,
  },
});
```

Either `workId` or the full slug triple is enough to activate broker mode. If
you pass both, the explicit `workId` wins and no lookup is performed. Inside
the Cohub iframe both are ignored (bridge mode).

### Standard initialization sequence

```js
// 1. Create client (env is mandatory in the browser)
const client = createCohubClient({ env: isDevWork ? "dev" : "prod" });

// 2. Get runtime context
const ctx = await client.context();
if (!ctx?.space?.id) {
  // Not in a Work runtime (or broker mode — see §2)
  throw new Error("Not running inside a published Work.");
}

// 3. Obtain the space client for API calls
const spaceId = ctx.space.id;
const space = client.space(spaceId);

// 4. Request viewer scopes (from a user gesture, e.g. button click)
const ok = await client.auth.request({
  scopes: ["session.prompt.fullaccess", "generation.create"],
  reason: "This Work needs to send prompts and generate images.",
});
if (!ok) {
  // Viewer denied — handle gracefully
}

// 5. Call capabilities
const result = await space.prompt({ content: [{ type: "text", text: "Hello" }] });
```

> **`auth.request` must be called from a user gesture** (click handler).
Browsers block popups (broker mode) and some consent flows (bridge mode)
when triggered programmatically without user activation. Do not call it on
page load.

---

## 5. Capability reference

Each recipe below shows the exact code pattern and scope requirements.
Assume `client` and `space` are already initialized per [§4](#4-initialization-recipe).

### LLM chat (`space.prompt` + `subscribeGeneration`)

**Scopes:** viewer `session.prompt.fullaccess` (to send) + work `session.view` (to read/stream).
For a read-only prompt (no side effects), use viewer `session.prompt.readonly`
instead — but you **must** pass `accessMode: "read_only"` in the call (see the
read-only recipe below).

> **`accessMode` defaults to `full_access`.** If you omit it, the backend
treats the call as full-access and requires `session.prompt.fullaccess`. This
is the #1 cause of "I requested `session.prompt.readonly` but still got 403".
Always set `accessMode` explicitly to match the scope you requested.

`space.prompt()` is **asynchronous** — it returns immediately with a turn
whose `assistantText` is `null`. You must either stream the reply via
`subscribeGeneration` or poll `turns.get()`.

```js
// Send a prompt (creates or continues a session) — full access
const result = await space.prompt({
  accessMode: "full_access", // default; needs session.prompt.fullaccess
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null,        // null → creates a new session; pass an id to continue
  model: "gpt-5.5",       // optional; omit for default
  intent: "followup",     // "followup" | "steer" | "compact"
});
const sessionId = result.session.id;
const turnId = result.turn.id;

// --- Option A: stream the reply (preferred) ---
// Requires work scope: session.view
const stop = space.session(sessionId).subscribeGeneration({
  state(event) {
    // Partial text as it streams in
    const text = (event.state?.contentBlocks ?? [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    console.log("streaming:", text);
  },
  finalized(event) {
    const turn = event.turn;
    const reply = turn.assistantText
      ?? (turn.assistantContent ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    console.log("final:", reply);
  },
  error(event) {
    console.error("stream error:", event);
  },
});
// Call stop() to unsubscribe when done.

// --- Option B: poll for the reply (fallback) ---
// Also requires work scope: session.view
async function waitForTurn(sessionId, turnId) {
  while (true) {
    const { turn } = await space.session(sessionId).turns.get(turnId);
    if (turn.status === "completed") return turn;
    if (turn.status === "failed") throw new Error(turn.errorMessage || "failed");
    await new Promise(r => setTimeout(r, 1500));
  }
}
const turn = await waitForTurn(sessionId, turnId);
const reply = turn.assistantText;
```

**Turn status values:** `"pending" | "running" | "completed" | "failed"`.

**Turn reply fields:** `turn.assistantText` (string | null) and
`turn.assistantContent` (ContentBlock[] | null). Always check both —
`assistantText` is a convenience; `assistantContent` is the source of truth.

> **Do not silently swallow `subscribeGeneration` errors.** If the work scope
`session.view` is missing, the WebSocket subscription fails. If you catch and
ignore it, your code silently degrades to polling — which will also 403.
Surface the error so you can diagnose the missing scope.

#### Read-only prompt (`accessMode: "read_only"`)

Use this when your Work only needs to **generate** a reply without persisting
any side effects (no new session is written, no turn stored on the space's
history). It requires the lighter viewer scope `session.prompt.readonly`
instead of `session.prompt.fullaccess`.

The critical detail: you **must** pass `accessMode: "read_only"` explicitly
in the `space.prompt()` call. The scope you request via `auth.request` and
the `accessMode` you send must match — the backend picks the permission check
based on `accessMode`, defaulting to `full_access` when omitted.

```js
// 1. Request ONLY the read-only scope from a user gesture
await client.auth.request({
  scopes: ["session.prompt.readonly"],
  reason: "Generate a one-off character reply (read-only).",
});

// 2. Send the prompt with accessMode matching the granted scope
const result = await space.prompt({
  accessMode: "read_only",   // ← required; omitting it → full_access → 403
  sessionId: null,           // read-only prompts use a throwaway session
  content: [{ type: "text", text: prompt }],
});
const sessionId = result.session.id;
const turnId = result.turn.id;

// 3. Read the reply — still needs the work scope: session.view
const stop = space.session(sessionId).subscribeGeneration({
  finalized: (event) => {
    const reply = event.turn.assistantText
      ?? (event.turn.assistantContent ?? [])
          .filter(b => b.type === "text").map(b => b.text).join("");
    console.log("reply:", reply);
    stop();
  },
  error: (event) => console.error("stream error:", event),
});
```

Publish the Work with:
- workScopes: `["space.view", "session.view"]` (still needed to read the reply)
- allowedViewerScopes: `["session.prompt.readonly"]`

> **Scope/accessMode mismatch → 403.** Requesting `session.prompt.readonly`
but calling `space.prompt({ content })` (no `accessMode`) fails because the
backend defaults to `full_access` and checks `session.prompt.fullaccess`.
Symmetrically, requesting `session.prompt.fullaccess` while passing
`accessMode: "read_only"` also works only if `session.prompt.readonly` is
additionally granted — otherwise 403. Always keep them in sync.

### Image / media generation (`generations.createAndWait`)

**Scopes:** viewer `generation.create` (to create) + work `taskrun.view` (to poll).

`createAndWait` is a convenience that calls `create` then `wait` (polls
`GET /api/tasks/{id}`). **Both scopes are required** — `generation.create`
for the create step, `taskrun.view` for the poll step. Missing `taskrun.view`
is the #1 cause of "generation creates but never returns" bugs.

```js
const result = await client.generations.createAndWait(
  {
    spaceId,
    model: "gpt-image-2",          // model id from models.listMultimodal()
    content: [{ type: "text", text: "A cat on the moon, cartoon style" }],
    parameters: {                   // optional, model-specific
      size: "1024x1024",
      // quality: "auto",           // gpt-image-2 supports quality
    },
  },
  {
    onPoll: (detail) => console.log("status:", detail.run.status),
    // intervalMs: 1500,            // optional poll interval
    // timeoutMs: 30 * 60 * 1000,   // optional timeout (default 30 min)
  },
);

// Extract the image URL from the output blocks
const image = (result.output ?? []).find(
  b => b.type === "image" && b.source?.url
);
const imageUrl = image?.source?.url;
```

**Output block types:** `text`, `image`, `video`, `audio`. Each media block has
a `source` of `{ type: "url", url }` or `{ type: "base64", mediaType, data }`.

**Two-step alternative** (if you need the `taskRunId` immediately):

```js
const created = await client.generations.create(request);
// created.taskRunId — generation task is queued
const result = await client.generations.wait(created.taskRunId, { onPoll });
```

### Model listing (`models.list` / `models.listMultimodal`)

**Scopes:** none — only requires a valid authenticated token (any token, no
specific scope). Returns 401 without a token, but never 403.

Call after initialization (after `context()` succeeds, so a token exists):

```js
// All models grouped by provider
const catalog = await client.models.list();
// catalog: { cohub: [...], openai: [...], ... }

// Generation-capable models only (for image/video/audio generation)
const { models } = await client.models.listMultimodal();
// models: [{ model, title, description, ... }, ...]
```

Use `listMultimodal()` to populate a model picker for generation. Each entry's
`model` field is the id you pass to `generations.createAndWait({ model })`.

### File reads (`space.files`)

**Scopes:** work `file.view` (read) + `space.view` (often needed for the space context).

```js
// List the file tree
const tree = await space.files.tree();
// tree: nested file/directory entries

// Read a file (returns an HTTP Response — .text() / .blob() / .arrayBuffer())
const response = await space.files.read("path/to/file.txt");
const text = await response.text();

// Read multiple files at once
const files = await space.files.readMany(["a.txt", "b.json"]);
```

### Account-level data (`spaces.list` / `user.listSessions` / `user.getUsage`)

**Scopes:** viewer `user.space.list` / `user.session.list` / `user.usage.read`.

These access the **viewer's** account-level data across all their spaces — not
the Work's own space. Each requires a separate viewer scope.

```js
// List the viewer's spaces — needs user.space.list
await client.auth.request({
  scopes: ["user.space.list"],
  reason: "Show your space list.",
});
const spaces = await client.spaces.list();

// List sessions across all the viewer's spaces — needs user.session.list
await client.auth.request({
  scopes: ["user.session.list"],
  reason: "List your recent sessions.",
});
const { sessions } = await client.user.listSessions({ limit: 20 });

// Read aggregated usage — needs user.usage.read
await client.auth.request({
  scopes: ["user.usage.read"],
  reason: "Show your usage summary.",
});
const usage = await client.user.getUsage(30); // last 30 days
```

### Commerce (`work.commerce`)

**Scopes:** none — runs inside the Work runtime, no scope needed. Only works
in a published Work.

```js
// Check entitlements and credit balance in one call
const { entitlements, credits } = await client.work.commerce.getEntitlements();

// Feature unlock: purchase if not entitled
const unlocked = entitlements.some(e => e.benefitKey === "space_pro" && e.enabled);
if (!unlocked) {
  await client.work.commerce.purchase({ productKey: "pro_unlock" });
  // purchase() redirects to checkout; after return, re-check entitlements
}

// Credit consumption for a metered action
const result = await client.work.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),  // idempotency key
  reason: "Export high-res image",
});
if (result.status === "insufficient") {
  await client.work.commerce.purchase({ productKey: "credit_pack" });
}

// After checkout return, query the order
const checkoutState = await client.work.commerce.getCheckoutState();
if (checkoutState.orderId) {
  const { order } = await client.work.commerce.getOrder(checkoutState.orderId);
}
```

`purchase()` creates a purchase attempt ID automatically. If application code
retries the call after a timeout, pass the same `purchaseAttemptId` to ensure
the retry resolves to the original Billing order.

### Realtime rooms (`work.realtime`)

**Scopes:** none — uses the published Work's runtime identity without an
additional consent dialog. The CLI and ordinary server auth cannot create or
join these rooms.

```js
const room = await client.work.realtime.createRoom({
  code: "TEAM-ALPHA", // optional; generated when omitted
  maxParticipants: 64,
  expiresInSeconds: 2 * 60 * 60,
});

const stopEvents = room.subscribe("shared.state.updated", (event) => {
  console.log(event.sequence, event.data, event.self);
});
console.log(room.members); // initial snapshot
const stopMembers = room.onMembersChanged((members) => {
  console.log(members);
});

await room.setPresence({ status: "active" });
await room.publish("shared.state.updated", { value: 42 });

stopEvents();
stopMembers();
await room.leave();
```

Join an existing room with
`client.work.realtime.joinRoom({ code: "TEAM-ALPHA" })`. Codes are scoped to
one Work and are identifiers, not credentials; the runtime session and a
short-lived admission ticket provide authorization.

| Surface | Purpose |
|---|---|
| `createRoom()` / `joinRoom()` | Create or enter a code-scoped room |
| `subscribe()` / `subscribeAll()` | Receive typed or all business events |
| `publish()` | Send an acknowledged event; accepts an optional correlation-only `clientEventId` |
| `send()` / `onSendError()` | Send without an ACK for high-rate traffic; observe asynchronous failures |
| `members` / `onMembersChanged()` | Read the initial member snapshot and later membership or presence changes |
| `setPresence()` | Replace this participant's transient presence object |
| `state` / `onStateChange()` | Observe `connecting`, `joined`, `reconnecting`, `expired`, or `closed` |
| `onOutOfSync()` | Detect sequence jumps in the current live stream |
| `leave()` | Release membership and SDK listeners |

Room events are ordered while connected but are not replayed. A reconnect
refreshes the member snapshot and advances the sequence cursor, so use
`onStateChange()` to resync authoritative application state after reconnecting;
`onOutOfSync()` only reports gaps visible in the current live stream. Payloads
are transient and are not stored in the Work.

| Limit | Value |
|---|---|
| Room code | Generated when omitted; custom codes are 3–48 uppercase letters, digits, `_`, or `-`, starting with a letter or digit |
| Lifetime | 2 hours by default; 60 seconds to 24 hours, absolute from creation |
| Participants | 16 by default; 2–128 |
| Active rooms | 512 per Work |
| Event name | 1–64 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a letter or digit; `cohub.*` is reserved |
| Event payload | 16 KB of JSON |
| Presence payload | 2 KB of JSON |
| Publish rate | 2,000 events per second per room |
| Presence rate | 30 updates per second per connection |
| Pending mutations | 256 per connection before backpressure errors |

`createRoom()` returns HTTP 429 with `ROOM_QUOTA_EXCEEDED` at the active-room
limit. Activity never extends `expiresAt`; expired rooms release their slot
automatically.

#### High-frequency events

`publish()` waits for an ACK, so a loop that awaits each call is capped at
roughly `1000 / RTT` events per second. Use `send()` for input frames and other
high-rate traffic:

```js
room.onSendError((error) => console.warn("dropped frame", error.message));
room.onStateChange((state) => {
  if (state !== "joined") pauseSimulation();
});

room.send("input.frame", { frame, pad });
```

`send()` preserves server ordering but drops calls while the room is not joined
and reports rate, validation, membership, and backpressure failures through
`onSendError()`. Use `publish()` whenever a specific event must be confirmed.

#### Seats and participant identity

Every connection is a participant by default, so two tabs appear twice. Each
member includes an opaque `userKey` that is stable for one room and viewer,
letting an application group connections without seeing the account ID.

Set `seatPerUser: true` when each viewer should occupy at most one seat:

```js
const room = await client.work.realtime.createRoom({
  maxParticipants: 2,
  seatPerUser: true,
});
```

A second tab or reconnect takes over the existing seat instead of consuming a
new one. The server keeps the participant ID, updates `room.participantId`, and
closes the superseded connection without emitting a leave event. Without this
mode, an unclean disconnect can retain its seat lease for up to one minute.

#### UI command calls that complete later

A `preview.show` command with a Surface request stays pending after the Work
acknowledges it. The host waits for the Work to be mounted and ready, then the
Work receives the originating `commandId` in the handler context and returns an
acknowledgement immediately:

```js
let activeCommandId = null;

client.work.surface.handle("image.open", async (input, { commandId }) => {
  if (!commandId) throw new Error("image.open must be called by a UI command");
  activeCommandId = commandId;
  openImageStudio(input);
  return { accepted: true };
});

async function useImage(result) {
  if (!activeCommandId) return;
  await client.ui.reportResult(activeCommandId, {
    status: "applied",
    result,
    error: null,
  });
  activeCommandId = null;
}
```

The Work should persist the command id alongside its local/server-backed draft
so a reload can restore the pending interaction. A Work session may only report a command that targets that same Work. Existing
`client.work.surface.handle(method, handler)` usage remains unchanged.

---

## 6. Complete working example

A no-build HTML Work for LLM chat and image generation. Use it as a starting
point and keep only the capabilities you need.

> **Publish this Work with:**
> - workScopes: `["space.view", "session.view", "taskrun.view"]`
> - allowedViewerScopes: `["session.prompt.fullaccess", "generation.create"]`
>
> See [§8](#8-publishing-a-work-apisdk) for the publish API call.

### `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cohub SDK Demo</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <h1>Cohub SDK Demo</h1>

    <section class="card">
      <h2>1. Context</h2>
      <button id="btn-context" class="btn">Get context</button>
      <pre id="output-context" class="output"></pre>
    </section>

    <section class="card">
      <h2>2. Authorize</h2>
      <button id="btn-auth" class="btn">Request viewer scopes</button>
      <pre id="output-auth" class="output"></pre>
    </section>

    <section class="card">
      <h2>3. LLM chat</h2>
      <div id="chat-log" class="chat-log"></div>
      <textarea id="chat-input" rows="2">Say hello in one sentence.</textarea>
      <button id="btn-chat" class="btn">Send</button>
      <pre id="output-chat" class="output"></pre>
    </section>

    <section class="card">
      <h2>4. Image generation</h2>
      <textarea id="img-prompt" rows="3">A cat on the moon, cartoon style</textarea>
      <button id="btn-img" class="btn">Generate</button>
      <div id="img-result"></div>
      <pre id="output-img" class="output"></pre>
    </section>
  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
```

### `app.js`

```js
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@latest";

// --- Environment detection (critical: browsers don't inject ENV) ---
const isDevWork =
  location.pathname.startsWith("/dev/") ||
  location.hostname.includes("dev");

const client = createCohubClient({
  env: isDevWork ? "dev" : "prod",
});

const REQUIRED_SCOPES = ["generation.create", "session.prompt.fullaccess"];

let space = null;
let spaceId = null;
let sessionId = null;

const $ = (id) => document.getElementById(id);

function setOutput(el, data) {
  el.textContent = typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
}

function log(el, msg) {
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}

// --- Runtime initialization ---
async function ensureRuntime(outEl) {
  const ctx = await client.context();
  if (!ctx?.space?.id) {
    throw new Error("Not running inside a published Work runtime.");
  }
  spaceId = ctx.space.id;
  space = client.space(spaceId);
  return ctx;
}

// --- Viewer scope management ---
function getViewerScopes(ctx) {
  return ctx?.permissions?.viewerScopes ?? [];
}

function missingViewerScopes(ctx, scopes) {
  const have = new Set(getViewerScopes(ctx));
  return scopes.filter((s) => !have.has(s));
}

async function ensureViewerScopes(scopes, reason, outEl) {
  const ctx = await ensureRuntime(outEl);
  const missing = missingViewerScopes(ctx, scopes);
  if (missing.length === 0) {
    log(outEl, `Already have scopes: [${scopes.join(", ")}]`);
    return true;
  }
  log(outEl, `Requesting scopes: [${missing.join(", ")}]...`);
  const ok = await client.auth.request({ scopes, reason });
  log(outEl, ok ? "Authorized." : "Authorization denied.");
  return ok;
}

// --- LLM chat (space.prompt + subscribeGeneration) ---
function extractText(blocks) {
  return (blocks ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function waitForTurn(sid, turnId, onStream) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = null;

    const finish = (fn) => {
      if (done) return;
      done = true;
      if (stop) try { stop(); } catch {}
      fn();
    };

    // Primary path: stream via WebSocket (needs work scope: session.view)
    try {
      stop = space.session(sid).subscribeGeneration({
        state: (event) => {
          const text = extractText(event.state?.contentBlocks);
          if (text) onStream?.(text);
        },
        finalized: (event) => finish(() => resolve(event.turn)),
        error: (event) => finish(() =>
          reject(new Error(event?.rawEvent?.payload?.message || "stream error"))),
      });
    } catch (err) {
      console.warn("subscribeGeneration failed:", err);
    }

    // Fallback: poll (also needs session.view — if missing, both paths 403)
    const poll = async () => {
      try {
        const { turn } = await space.session(sid).turns.get(turnId);
        if (turn.assistantText) onStream?.(turn.assistantText);
        if (turn.status === "completed") finish(() => resolve(turn));
        if (turn.status === "failed" || turn.status === "cancelled") {
          finish(() => reject(new Error(turn.errorMessage || "failed")));
        }
      } catch (err) {
        // Don't silently swallow — surface 403 (missing session.view)
        console.error("poll error:", err);
      }
    };
    const interval = setInterval(poll, 2000);
    poll();
    setTimeout(() => finish(() => reject(new Error("timeout"))), 120000);
    // Note: in production, clear the interval in finish()
  });
}

async function chat(text, outEl) {
  const result = await space.prompt({
    content: [{ type: "text", text }],
    sessionId: sessionId || null,
    intent: "followup",
  });
  sessionId = result.session.id;
  const turn = await waitForTurn(sessionId, result.turn.id);
  return turn.assistantText || extractText(turn.assistantContent) || "(empty)";
}

// --- Image generation (generations.createAndWait) ---
async function generateImage(prompt, outEl) {
  const result = await client.generations.createAndWait(
    {
      spaceId,
      model: "gpt-image-2",
      content: [{ type: "text", text: prompt }],
      parameters: { size: "1024x1024" },
    },
    { onPoll: (d) => log(outEl, `poll: ${d.run.status}`) },
  );
  const image = (result.output ?? []).find(
    (b) => b.type === "image" && b.source?.url,
  );
  return image?.source?.url ?? null;
}

// --- Event handlers (auth.request must be in a user gesture) ---
$("btn-context").addEventListener("click", async () => {
  const out = $("output-context");
  out.textContent = "";
  try {
    const ctx = await client.context();
    setOutput(out, {
      "work.id": ctx?.work?.id,
      "space.id": ctx?.space?.id,
      permissions: ctx?.permissions,
    });
  } catch (err) { log(out, err.message); }
});

$("btn-auth").addEventListener("click", async () => {
  const out = $("output-auth");
  out.textContent = "";
  const ok = await ensureViewerScopes(
    REQUIRED_SCOPES,
    "This demo needs to send prompts and generate images.",
    out,
  );
  if (ok) log(out, "Ready to use capabilities.");
});

$("btn-chat").addEventListener("click", async () => {
  const out = $("output-chat");
  out.textContent = "";
  const text = $("chat-input").value.trim();
  if (!text) return;
  try {
    await ensureRuntime(out);
    const ok = await ensureViewerScopes(
      ["session.prompt.fullaccess"],
      "LLM chat needs session.prompt.fullaccess.",
      out,
    );
    if (!ok) return;
    const reply = await chat(text, out);
    log(out, `Reply: ${reply}`);
  } catch (err) { log(out, err.message); }
});

$("btn-img").addEventListener("click", async () => {
  const out = $("output-img");
  out.textContent = "";
  const prompt = $("img-prompt").value.trim();
  if (!prompt) return;
  try {
    await ensureRuntime(out);
    const ok = await ensureViewerScopes(
      ["generation.create"],
      "Image generation needs generation.create. taskrun.view comes from workScopes.",
      out,
    );
    if (!ok) return;
    const url = await generateImage(prompt, out);
    if (url) {
      $("img-result").innerHTML = `<img src="${url}" style="max-width:100%" />`;
    }
    log(out, "Done.");
  } catch (err) { log(out, err.message); }
});

// Auto-fetch context on load (does not require auth)
(async () => {
  try {
    const ctx = await client.context();
    if (ctx) {
      setOutput($("output-context"), {
        "work.id": ctx.work?.id,
        "space.id": ctx.space?.id,
        permissions: ctx.permissions,
      });
    }
  } catch {}
})();
```

---

## 7. Common pitfalls checklist

Before publishing your Work, verify each item:

- [ ] **Environment**: passed `env: "dev"` (or `"prod"`) explicitly — the SDK
  defaults to prod and browsers don't inject `ENV`.
- [ ] **Work scopes include all read operations**: `space.view`, `session.view`
  (for LLM reply reads), `taskrun.view` (for generation polling), `file.view`
  (for file reads). Missing any of these → 403 on reads.
- [ ] **Viewer scopes include all action operations**: `session.prompt.fullaccess`
  (or `.readonly`) for prompts, `generation.create` for generation.
- [ ] **`session.prompt.*` scope matches `space.prompt({ accessMode })`.**
  Omitting `accessMode` defaults to `full_access`, so requesting only
  `session.prompt.readonly` and then calling `space.prompt({ content })` → 403.
  Set `accessMode: "read_only"` explicitly when using the readonly scope.
- [ ] **`session.prompt.fullaccess` does NOT include `session.view`** — they
  are separate. Sending a prompt succeeds but reading the reply 403s without
  `session.view`.
- [ ] **`generation.create` does NOT include `taskrun.view`** — creating a
  generation task succeeds but polling the result 403s without `taskrun.view`.
- [ ] **`auth.request()` is called from a user gesture** (button click), not
  on page load.
- [ ] **`subscribeGeneration` errors are not silently swallowed** — if the
  stream fails, surface it; a silent fallback to polling will also 403 if
  `session.view` is missing.
- [ ] **Broker mode**: if the Work may be accessed standalone, pass
  `work: { brokerOrigin, workId }` and call `auth.request()` before any other
  API call (to avoid user-activation exhaustion).
- [ ] **Space has a slug and owner has a username** before publishing — the
  API rejects Works when either is missing.
- [ ] **Model ids are not hardcoded** — use `client.models.listMultimodal()`
  to fetch available models dynamically (requires auth but no scope).

---

## 8. Publishing a Work (API/SDK)

Before creating a Work through the API, ensure the owner has a username and
the Space has a slug. The API rejects Works when either public identity part
is missing.

```js
// Create a single-file Work (HTML file)
await client.works.create({
  spaceId,
  slug: "my-html-demo",
  status: "published",
  targetType: "file",
  targetRef: "demo/index.html",
  workScopes: ["space.view", "session.view", "taskrun.view"],
  allowedViewerScopes: ["session.prompt.fullaccess", "generation.create"],
});

// Create a directory Work (must contain index.html)
await client.works.create({
  spaceId,
  slug: "my-site",
  status: "published",
  targetType: "directory",
  targetRef: "site",
  workScopes: ["space.view", "session.view", "taskrun.view", "file.view"],
  allowedViewerScopes: ["session.prompt.fullaccess", "generation.create"],
});

// Create a port Work (sandbox dev server)
await client.works.create({
  spaceId,
  slug: "live-preview",
  status: "published",
  targetType: "port",
  targetRef: "5173",
  workScopes: ["space.view"],
  allowedViewerScopes: [],
});
```

`targetRef` is a path **relative to the Space filesystem root** (not a local
path). For file Works, the target must be an HTML file (`.html`/`.htm`).

Update the published version from the current target:

```js
await client.works.publishVersion(workId);
```

Other SDK methods: `works.get(workId)`, `works.getBySlug(username, spaceSlug,
workSlug)`, `works.listBySpace(spaceId)`, `works.update(workId, input)`,
`works.delete(workId)`.
`works.getBySlug(username, spaceSlug,
workSlug)`, `works.listBySpace(spaceId)`, `works.update(workId, input)`,
`works.delete(workId)`.
