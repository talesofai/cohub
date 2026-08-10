---
title: SDK
description: Use the Cohub TypeScript SDK for Spaces, Chats, Works, realtime updates, and Work runtime APIs.
---

The Cohub SDK is the TypeScript client for product APIs and realtime collaboration.

Package: `@neta-art/cohub`

## Install

```bash
npm install @neta-art/cohub
```

## Create a client

```ts
import { createCohubClient } from "@neta-art/cohub";

const client = createCohubClient({
  getAccessToken: async () => localStorage.getItem("token"),
});
```

Defaults:

| Env | API | WebSocket |
| --- | --- | --- |
| production | `https://api.cohub.run` | `wss://gateway.cohub.run/ws` |
| development | `https://api-dev.cohub.run` | `wss://gateway-dev.cohub.run/ws` |

Select development:

```ts
const client = createCohubClient({
  env: "dev",
  getAccessToken: async () => token,
});
```

Or with `ENV=dev` in Node.js.

Custom endpoints are supported when self-hosting or proxying.

## Spaces and Chats

```ts
const created = await client.spaces.create({ name: "Demo" });
const space = client.space(created.space.id);

const sessionResult = await space.sessions.create({ title: "Planning" });
const session = space.session(sessionResult.session.id);

await session.messages.send({
  content: [{ type: "text", text: "Help me plan the next steps" }],
});
```

Product mapping:

- Space → `client.spaces` / `client.space(id)`
- Chat → session APIs under a Space
- Save → checkpoint APIs under a Space
- Work → `client.works`

## Session realtime

Subscribe to session events while an Agent is working:

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

## Works

Create and manage Works through `client.works`, including publish, update, versions, and lookups by slug.

For ordinary server/automation code, use normal user auth. For code **inside a published Work**, use the Work runtime APIs below.

## Work runtime

Published Works can run with short-lived runtime auth provided by the Cohub shell.

```ts
const client = createCohubClient(); // token comes from Work runtime

const context = await client.context();
// Work identity, Space identity, viewer state

await client.auth.request({
  scopes: ["session.prompt.readonly"],
  reason: "Continue the demo chat",
});
```

Important:

- Runtime APIs work inside a published Work
- They do not work from arbitrary static hosting or local file open
- Work scopes and viewer-consent scopes are enforced

Commerce helpers live under `client.work.commerce.*` when commerce is enabled and the Work is published.

### Realtime rooms

Inside a published Work, `client.work.realtime` provides temporary rooms for
multiplayer state, presence, and generic JSON events. It uses the Work runtime
identity and needs no additional scope or consent dialog.

```ts
const room = await client.work.realtime.createRoom({
  code: "TEAM-ALPHA", // optional
  expiresInSeconds: 2 * 60 * 60,
});

const stop = room.subscribe("shared.state.updated", ({ data }) => {
  console.log(data);
});

await room.publish("shared.state.updated", { value: 42 });
stop();
await room.leave();
```

Events are ordered while connected but are not replayed. Use `room.send()` for
high-rate traffic, and resync authoritative state after reconnecting. Realtime
rooms are runtime-only; normal server auth and the CLI cannot create or join
them.

See the [Work Runtime Guide](https://github.com/talesofai/cohub/blob/main/packages/sdk/docs/work-runtime-guide.md#realtime-rooms-workrealtime)
for lifecycle, presence, membership, seat, and limit details.

### Callable surface

A Work can expose named methods to the Cohub host embedding it, so an Agent can
call into the running Work with `cohub ui preview <work> --call <method>`.

```ts
client.work.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});

await client.ui.reportResult(commandId, {
  status: "applied",
  result: selectedImage,
  error: null,
});
```

Only registered methods are reachable. There is no DOM access or script
execution. A Surface response only acknowledges delivery; the Work reports the
final result through the same UI command with `client.ui.reportResult()`.

Calls are delivered at-least-once, so prefer methods that are safe to repeat.

### Composer context

A Work running in the workspace preview can attach one compact context chip to
the Cohub composer. The label stays short while the full content is available to
the user and sent with each message while attached:

```ts
client.work.composer.setChip({
  key: "selection",
  label: "3 selected",
  content: "Selected records:\n- customer_123\n- customer_456\n- customer_789",
});

client.work.composer.clearChip("selection");
```

Calling `setChip()` again with the same key updates the existing chip. Cohub owns
the chip's appearance and treats its content as plain text. Labels are limited to
120 characters and content to 32KB. The chip is only attached while that Work is
the active preview; closing or reloading the surface clears it.

Because a published Work is publicly embeddable, surface calls and composer
context are accepted only from an
explicit list of Cohub app origins (or the Work's own origin), and replies go to
that origin rather than being broadcast. A Work embedded by any other site
registers its methods but never answers. The list is deliberately not a
`*.cohub.run` suffix match, since Works themselves are served from a Cohub
subdomain. Self-hosted deployments and local development widen it explicitly:

```ts
client.work.surface.allowHostOrigins(["https://cohub.internal"]);
```

## Main client surfaces

The client groups product APIs intentionally:

| Area | Client surface |
| --- | --- |
| Spaces / sessions / files | `client.spaces`, `client.space(id)` |
| Works | `client.works` |
| Generations | `client.generations` |
| Models | `client.models` |
| Search | `client.search` |
| Tasks / cron | `client.tasks`, `client.cronJobs` |
| Channels | `client.channels` |
| Billing / commerce | `client.billing`, `client.workCommerce` |
| Work runtime | `client.context()`, `client.auth`, `client.work` |
| Cohub UI commands | `client.ui` |

Use only the surfaces you need. Start with Spaces, sessions, and Works.

## Auth model

Outside Work runtime:

- Provide `getAccessToken`
- Optionally handle token storage helpers if you integrate login yourself

Inside Work runtime:

- The host can provide short-lived tokens
- Request additional viewer scopes only when required

Prefer least privilege for any Work that runs in other people’s browsers.

## Practical tips

- Reuse one client instance per app shell
- Prefer Space-scoped helpers (`client.space(id)`) for readable code
- Use realtime subscriptions for streaming UX, not tight polling loops
- Keep product terms aligned in UI copy: Chat/Save, not session/checkpoint

## Related

- [CLI](/docs/developers/cli)
- [Works](/docs/create/works)
- [Core concepts](/docs/learn/core-concepts)
