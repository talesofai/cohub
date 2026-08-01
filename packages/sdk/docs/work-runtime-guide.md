# Cohub Work Runtime Guide

This guide explains how to use the Cohub SDK **inside a published Work** — the
only environment where runtime APIs (`context()`, `auth.request`,
`work.commerce.*`) function. Read this before writing any Work that calls Cohub
capabilities from browser-side JavaScript.

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

Three runtime-only APIs form the foundation; everything else is standard SDK:

| API | What it does | Returns |
|---|---|---|
| `client.context()` | Asks the host for the Work's identity | `{ work, space, viewer?, permissions }` or `null` |
| `client.auth.request({ scopes, reason })` | Shows the viewer a consent dialog; on approval, caches a token carrying those scopes | `true` / `false` |
| `client.work.commerce.*` | Entitlement checks, credit consumption, purchases | (see Commerce section) |

> **Runtime-only constraint.** These three APIs only work inside a **published**
> Work. Outside that context (a static asset URL, a local `file://` preview,
> a plain Node script) `context()` returns `null` and `auth.request` / commerce
> calls fail. Always develop against a published Work.

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
session.view     — read every visible session and turn in the Work's Space
file.view        — read files / file tree
taskrun.view     — read every visible task run in the Work's Space
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
user.session.list         — list the viewer's sessions across spaces (redacted by default)
user.usage.read           — read the viewer's aggregated usage
```

### The golden rule

> **Space-wide reads need work scopes. Owner-bound reads require the matching
> viewer action grant and never apply to preview or execution principals.**

`session.prompt.fullaccess` or `session.prompt.readonly` lets the viewer send a
prompt and poll the resulting session they own in the current Work Space.
`user.session.list` returns redacted summaries by default. A matching
`session.view` Work scope upgrades only records in that Work's exact Space; it
does not unlock records in any other Space or grant turn content by itself.
Reading another user's session still needs `session.view`. A Work can read only
generation tasks created by that same Work while its `generation.create` grant
remains active; `taskrun.view` never widens that Work recovery boundary.

### Complete API → scope mapping

| Operation | SDK call | Scope needed | Type |
|---|---|---|---|
| Read space config | `space.get()` / `space.getConfig()` | `space.view` | work |
| List models | `client.models.list()` / `listMultimodal()` | *(none — just authenticated)* | — |
| Send a prompt (full) | `space.prompt({ accessMode: "full_access", content, ... })` | `session.prompt.fullaccess` | viewer |
| Send a prompt (read-only) | `space.prompt({ accessMode: "read_only", content, ... })` | `session.prompt.readonly` | viewer |
| Read turn result | `session.turns.get(turnId)` | matching `session.prompt.*` grant for the viewer's own session in this Work Space; otherwise `session.view` | viewer / work |
| Stream generation | `session.subscribeGeneration({ state, finalized })` | matching `session.prompt.*` for a viewer-owned session; otherwise `session.view` | viewer / work |
| Read file tree | `space.files.tree()` | `file.view` | work |
| Read file content | `space.files.read(path)` | `file.view` | work |
| Create generation task | `client.generations.create(request)` | `generation.create` | viewer |
| **Poll generation result** | `client.generations.wait(taskRunId)` / `createAndWait()` | matching `generation.create` grant and task created by this Work | viewer / work |
| Read task run detail | `client.tasks.get(taskRunId)` | same-Work generation task + `generation.create`; non-Work Space readers use `taskrun.view` | viewer / work |
| List viewer's spaces | `client.spaces.list()` | `user.space.list` | viewer |
| List viewer's sessions | `client.user.listSessions()` | `user.session.list` | viewer |
| Read viewer's usage | `client.user.getUsage()` | `user.usage.read` | viewer |
| Commerce: entitlements | `client.work.commerce.getEntitlements()` | *(runtime only, no scope)* | — |
| Commerce: consume credits | `client.work.commerce.consumeCredits()` | *(runtime only, no scope)* | — |
| Commerce: purchase | `client.work.commerce.purchase()` | *(runtime only, no scope)* | — |

### Minimal scope sets for common Work types

**Privacy-scoped LLM chat Work** (send prompt + poll the viewer's own reply):
- workScopes: `["space.view"]`
- allowedViewerScopes: `["session.prompt.fullaccess"]` (add `user.session.list` only for a history picker)

**Image generation Work** (create + poll the viewer's own task):
- workScopes: `["space.view"]`
- allowedViewerScopes: `["generation.create"]`

**LLM + image generation Work** (the demo):
- workScopes: `["space.view"]`
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
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@2";
```

> Pin to a major version (`@2`) or an exact version (`@2.6.0`) to avoid
> breaking changes. Check `npm view @neta-art/cohub version` for the latest.

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

### LLM chat (`space.prompt` + owner polling or streaming)

**Scopes:** viewer `session.prompt.fullaccess` sends the prompt and reads or
streams the viewer-owned reply in the current Work Space. Add work
`session.view` only to read sessions beyond that owner boundary.
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

// --- Option A: stream the viewer-owned reply ---
// The matching session.prompt.fullaccess grant authorizes this Session room.
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

// --- Option B: poll the viewer-owned reply (privacy-scoped default) ---
// Uses the active session.prompt.fullaccess viewer grant.
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

> **Do not silently swallow `subscribeGeneration` errors.** The matching
> `session.prompt.*` grant must still be active for the viewer-owned Session
> room. If streaming fails, explicitly fall back to owner-bound polling and
> surface errors from both paths.

#### Read-only prompt (`accessMode: "read_only"`)

Use this when your Work only needs to **generate** a reply without execution
side effects. Cohub still persists the viewer-owned session and turn so the
reply can be polled and recovered; `read_only` limits the agent's execution
capabilities, not conversation history. It requires the lighter viewer scope
`session.prompt.readonly` instead of `session.prompt.fullaccess`.

The critical detail: you **must** pass `accessMode: "read_only"` explicitly
in the `space.prompt()` call. The scope you request via `auth.request` and
the `accessMode` you send must match — the backend picks the permission check
based on `accessMode`, defaulting to `full_access` when omitted.

```js
// 1. Request the read-only prompt scope from a user gesture
await client.auth.request({
  scopes: ["session.prompt.readonly"],
  reason: "Generate a one-off character reply (read-only).",
});

// 2. Send the prompt with accessMode matching the granted scope
const result = await space.prompt({
  accessMode: "read_only",   // ← required; omitting it → full_access → 403
  sessionId: null,           // Cohub creates a persisted viewer-owned session
  content: [{ type: "text", text: prompt }],
});
const sessionId = result.session.id;
const turnId = result.turn.id;

// 3. Poll the viewer-owned session without a Space-wide session.view grant.
const turn = await waitForTurn(sessionId, turnId);
console.log("reply:", turn.assistantText);
```

Publish the Work with:
- workScopes: `["space.view"]`
- allowedViewerScopes: `["session.prompt.readonly"]`

This privacy-scoped form can poll or stream a session owned by the viewer. Add
the broad `session.view` work scope only when the Work must inspect sessions
owned by other Space users.

> **Scope/accessMode mismatch → 403.** Requesting `session.prompt.readonly`
but calling `space.prompt({ content })` (no `accessMode`) fails because the
backend defaults to `full_access` and checks `session.prompt.fullaccess`.
`session.prompt.fullaccess` also satisfies a read-only prompt. Keep the requested
scope as narrow as the behavior actually needs.

### Image / media generation (`generations.createAndWait`)

**Scopes:** viewer `generation.create`. The created generation task is tagged
to both the viewer and the current Work, so that Work can list and poll its full
result. This grant never exposes non-generation tasks or generation tasks from
another Work, even for the same viewer and Space.

`createAndWait` is a convenience that calls `create` then `wait` (polls
`GET /api/tasks/{id}`). A Work cannot use `taskrun.view` to widen this recovery
boundary; non-Work Space clients use that permission for broad task reads.

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

// List sessions across the viewer's spaces — redacted unless this Work also
// has session.view in the matching Space.
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

---

## 6. Complete working example

A no-build HTML Work that tests LLM chat and image generation. This is the
exact pattern that was verified end-to-end. Adapt it to your needs.

> **Publish this Work with:**
> - workScopes: `["space.view"]`
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
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@2";

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

async function waitForTurn(sid, turnId, onStream) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { turn } = await space.session(sid).turns.get(turnId);
    const text = turn.assistantText || extractText(turn.assistantContent);
    if (text) onStream?.(text);
    if (turn.status === "completed") return turn;
    if (turn.status === "failed" || turn.status === "cancelled") {
      throw new Error(turn.errorMessage || "failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("timeout");
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
      "Image generation and owner-bound polling need generation.create.",
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
- [ ] **Work scopes include only required Space-wide reads**: typically
  `space.view` and, when needed, `file.view`. Add `session.view` or
  `taskrun.view` only when the Work intentionally reads other users' data.
- [ ] **Viewer scopes include all action operations**: `session.prompt.fullaccess`
  (or `.readonly`) for prompts, `generation.create` for generation.
- [ ] **`session.prompt.*` scope matches `space.prompt({ accessMode })`.**
  Omitting `accessMode` defaults to `full_access`, so requesting only
  `session.prompt.readonly` and then calling `space.prompt({ content })` → 403.
  Set `accessMode: "read_only"` explicitly when using the readonly scope.
- [ ] **Owner session reads use the matching `session.prompt.*` grant** and are
  limited to the viewer's own session in the current Work Space.
- [ ] **`user.session.list` is redacted per Session Space.** Full list records
  require `session.view` in that exact Space; one Space scope never unlocks
  another. The list permission does not grant turn or signed-media access.
- [ ] **Owner generation polling checks the authenticated user**. Do not add
  `taskrun.view` merely to poll a generation task just created by that viewer;
  `generation.create` does not expose other task types.
- [ ] **`auth.request()` is called from a user gesture** (button click), not
  on page load.
- [ ] **`subscribeGeneration` errors are not silently swallowed** — if the
  viewer-owned Session stream fails, fall back to owner-bound polling only
  while the matching `session.prompt.*` viewer grant remains active.
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
  workScopes: ["space.view"],
  allowedViewerScopes: ["session.prompt.fullaccess", "generation.create"],
});

// Create a directory Work (must contain index.html)
await client.works.create({
  spaceId,
  slug: "my-site",
  status: "published",
  targetType: "directory",
  targetRef: "site",
  workScopes: ["space.view", "file.view"],
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
