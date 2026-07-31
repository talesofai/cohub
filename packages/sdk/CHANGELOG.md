# @neta-art/cohub

## 4.4.0

### Minor Changes

- f514b5e: Add paginated Space-level Turn listing with author and time boundaries, including CLI access.

## 4.3.0

### Minor Changes

- 651476c: Expose mounted Mod provenance in skill catalog entries and show the source slug in CLI listings.

## 4.2.0

### Minor Changes

- 4e9e994: Add SDK support for publishing arbitrary files and read-only Boards as Works.

  Work responses now expose their content kind and immutable artifact metadata,
  including captured Board snapshots and assets.

- 22c00f4: Add negotiated presigned PUT support for durable chat attachments while retaining legacy POST uploads.

## 4.1.0

### Minor Changes

- 3a9a51d: Add delayed, looping Board autoplay configured through Board metadata.

## 4.0.1

### Patch Changes

- 1fb5002: Docs: clarify `accessMode` in the Work Runtime Guide to prevent read-only 403s.

  The permission table and all `space.prompt()` examples only showed full-access
  prompts, with no mention that `session.prompt.readonly` requires
  `accessMode: "read_only"` in the call. Since the backend defaults `accessMode`
  to `full_access`, requesting only `session.prompt.readonly` and reusing the
  example code (no `accessMode`) yielded a 403.

  - Split the "Send a prompt" table row into full-access / read-only rows that
    name the `accessMode` parameter explicitly.
  - Add an `accessMode`-default warning and a complete read-only prompt recipe
    (auth.request + space.prompt + subscribeGeneration) to the LLM chat section.
  - Add a pitfalls checklist item for scope / `accessMode` mismatch.

## 4.0.0

### Major Changes

- b9e6840: Remove note board nodes and render Markdown file-card titles from frontmatter.

### Minor Changes

- 9350706: Add shared Board geometry for Figma-style rotation zones outside selection corners.
- 9350706: Add black and white to the shared Board tool palette and color types.
- ba7d325: Add shared Board tool-style defaults and controls, and increase the default text size.

### Patch Changes

- c1eb8ef: Allow Board hosts to render a themed image backdrop beneath the transparent canvas.
- 95ae57d: Render freehand Board strokes with stable rounded outlines through sharp turns and self-intersections.
- a98f930: Add typed `work.version.published` Space realtime events.
- 9350706: Preserve image proportions in Board file-card covers and remove the metadata footer.

## 3.2.0

### Minor Changes

- 54cd4d0: Move the Board document model, renderers, and image exporters into the Cohub SDK, organised by dependency so each entry only carries what it needs:

  - `@neta-art/cohub/board` — document schema, geometry, shapes, timeline compilation, and export planning. No PixiJS, so it runs on servers, agents, and edge workers.
  - `@neta-art/cohub/board/render` — the PixiJS card renderers, themes, and palette the editor draws with.
  - `@neta-art/cohub/board/export` — rendering a planned export to a canvas in the browser.
  - `@neta-art/cohub/board/headless` — Node.js image export on `@napi-rs/canvas`.

  `pixi.js` and `@napi-rs/canvas` stay optional peers, needed only for the rendering and export entries. Board modules also keep their build boundaries, so consumers tree-shake unused schemas and renderers instead of pulling in the whole model.

## 3.1.0

### Minor Changes

- 94a8f99: Board realtime: add optional `client.formFactor` to awareness state so peers can present a mobile touch contact as such, and carry server-owned `metadata` (including request provenance) on `board.transaction.applied` for CLI / Agent attribution.
- b47510a: Add Board realtime awareness subscriptions and updates for cursors, selections, creation gestures, drawing, and transforms.

## 3.0.0

### Major Changes

- ac1a3ce: Adopt Board across SDK types, REST endpoints, file formats, and realtime events. Add bound `BoardClient` entities with transaction and playback subscriptions.

### Minor Changes

- 077ce83: Add the Space startup API for preloading UI configuration and local preview sessions.

## 2.15.0

### Minor Changes

- 7dfa1d8: Add optional `thinkingLevel` to session prompts, scheduled prompts, channel model config, and space hooks. The level is fully optional — omitted values inherit the session default, matching existing provider/model behavior. UI, CLI, and SDK all support per-model thinking level selection driven by models config (`reasoning`, `defaultThinkingLevel`, `thinkingLevelMap`). Effective thinking level is persisted to turn meta and exposed on turn records for multi-client recovery.

### Patch Changes

- 7dfa1d8: Add optional file write baselines and mutation identifiers for conflict-aware autosave.

## 2.14.1

### Patch Changes

- dad311e: Recover WebSocket sessions from a transient authentication failure by forcing one access-token refresh, reconnecting once, and restoring room subscriptions without entering an infinite retry loop.

## 2.14.0

### Minor Changes

- f72fa82: Expose structured canvas transaction conflicts and richer published Work metadata through the Cohub SDK and CLI dependency bundle.

  - Export `CanvasTransactionError` with status, code, and `isVersionConflict` so clients can rebase and retry rejected canvas transactions.
  - Add `lang` and `themeColor` to published Work metadata types.

## 2.13.0

### Minor Changes

- Carry request provenance via `X-Cohub-Source-*` headers for cross-space traceability.

  - **SDK**: `requestSource` on client options (static or per-request getter); transport stamps `X-Cohub-Source-*` automatically; re-export provenance helpers (`readRequestSourceFromEnv`, `requestSourceToHeaders`, `mergeRequestSourceIntoMeta`, …).
  - **CLI**: every request sends `via: cli` and sandbox `COHUB_*` identity when present; drop ad-hoc `meta.source` / `versionMeta` / `meta.cohub` merge on works and generations.
  - **Breaking note**: `WorkCreateInput.versionMeta` removed — publish provenance is taken from request headers instead.

## 2.12.0

### Minor Changes

- d21c200: Ship the resource-references graph-edge model and empty-account Home space bootstrap that the API and agent already expose.

  - **feat(references): graph-edge model with agent file access stats** — turn-level sources, file targets, and agent tool file kinds (`agent_tool_file_read|write|edit|ls|find|grep`); drop redundant `participant` edges; `ReferenceRecord` uses `sourceSpaceId` / `sourceSessionId`; aggregate supports `groupBy=target` and `limit`.
  - **feat: auto-create Home space for empty accounts** — `spaces.getDefault()` creates a blank Home space (`slug=home`) when the account has no accessible space.
  - **CLI**: `references query` accepts `turn:<uuid>`; aggregate `--group-by target` / `--limit`; file targets render as short space id + path.

## 2.11.2

### Patch Changes

- 1d27866: Stop silent SSO login callback redirect loops by letting bootstrap `getMe` skip the unauthorized handler, and ship Apache-2.0 LICENSE/NOTICE with the published packages.

## 2.11.1

### Patch Changes

- 43b7653: Record optional provenance on work versions via `meta` (CLI auto-fills `source` from COHUB\_\* env).

## 2.11.0

### Minor Changes

- 6c0b75f: Add durable chat attachments that no longer require a session.

  SDK: `publicAssets.uploadChatAttachment()` for any file mime, optional `spaceId`/`sessionId` association only, and space upload `downloadUrl` materialize (skip client PUT when the file is already a durable public asset). `sandbox_tmp` destination `sessionId` is optional; plan entries may omit `uploadUrl`/`objectKey` for remote sources.

  CLI: `spaces prompt --image` works without `--session`; file upload complete skips remote `downloadUrl` entries that the server pulls itself.

### Patch Changes

- 86e11a7: Expose generation model discount billing details in SDK results and CLI output.

## 2.10.0

### Minor Changes

- a45d3e8: Add referral links, account referral management, and CLI referral commands.

## 2.9.0

### Minor Changes

- 74a3b9d: Add raw space LLM completions that skip the agent turn queue. Callers fully control message history and an optional space-relative system prompt file.

  SDK: `space.completion()` (JSON) and `space.streamCompletion()` (SSE deltas with abort-safe streaming).
  CLI: `cohub completion` / `cohub spaces completion` with `--stream`, `--system-prompt`, model/provider, temperature, max tokens, and thinking level.

## 2.8.0

### Minor Changes

- 4c28633: Broker mode can now resolve the workId at runtime from the public slug triple. Standalone Works no longer need to hardcode a workId that only exists after publishing — pass `work: { brokerOrigin, ownerUsername, spaceSlug, workSlug }` and the SDK reverse-looks-up the workId via the anonymous `works.getBySlug` API, caches it, and starts broker mode. Explicit `workId` still takes precedence, and bridge mode (inside the Cohub iframe) is unaffected.
- 9188401: Unify billing gate responses. Every billing-gated 402 (negative balance limit and plan entitlement) now returns a flat `{ code, message, billing: { conversion, status?, netUsd?, hardNegativeLimitUsd? } }` body, and soft debt warnings ride the same `billing` payload on success responses. The SDK adds `BILLING_ACCESS_BLOCKED_ERROR_CODE`, `isBillingAccessBlockedError`, `isBillingAccessBlockedCode`, `extractBillingPayload`, and a `BillingResponsePayload` type so clients extract the conversion intent with one call. Websocket `session.request.error` events now carry the same `billing` payload. The CLI surfaces the conversion title/message on 402.

### Patch Changes

- 10989f6: Record multimodal generation usage against the shared credit balance after successful provider calls. Add `generation.music` usage type, resolve image/video/music kinds for billing gates, and surface post-success `billing` metadata on generation task results.

  Also add hourly generation usage stats (mirroring LLM token rollups) so multimodal usage appears in trending and usage endpoints.

## 2.7.1

### Patch Changes

- 55eeac2: Remove the Guides table from the README top section; the Work runtime overview section at the bottom already links to the guide.

## 2.7.0

### Minor Changes

- 348f62a: Add `docs/work-runtime-guide.md` — a self-contained guide for building published Works that use Cohub capabilities from browser-side JavaScript. Covers the two-scope model (work scopes for reads vs viewer scopes for actions), bridge vs broker deployment modes, initialization recipe, capability reference (LLM chat, image generation, model listing, file reads, account-level data, commerce), a complete working example, and a pitfalls checklist.

  Also ship the guide with the npm package (`docs` added to `files`) and add a Guides table + Work runtime overview to the README.

## 2.6.0

### Minor Changes

- 805d300: Add preview session creation for private HTML previews and preserve viewer-scoped authorization when work runtime tokens refresh.

## 2.5.0

### Minor Changes

- 1fe514d: Extracted the work bridge host logic into a framework-agnostic `createWorkBridgeCore` (pure TS, no Svelte runes) so external hosts like Neta-Studio (React) can reuse the same message handling, token minting, authorization, and purchase flow.

  - **New exports**: `createWorkBridgeCore`, `WorkBridgeCore`, `WorkBridgeCoreConfig`, `WorkBridgeCoreWork`, `WorkBridgeDialogState`, `WorkAuthorizeRequest`, `WorkPurchaseRequest`, `WorkBridgeGetAccessToken`, `WorkBridgeGetViewerUuid`, `WorkBridgeRequestSignIn`.
  - **Grant cache moved to SDK**: `hasGrantedWorkScopes`, `setGrantedWorkScopes`, `clearGrantedWorkScopes` are now exported from `@neta-art/cohub` (previously internal to the web app). The web app's `work-grant-cache.ts` re-exports them for backward compatibility.
  - **`bridge-host.svelte.ts`** is now a thin Svelte 5 wrapper that delegates to the shared core, injecting auth dependencies (`getAuthToken`, `authStore`, `signInWithRedirectPath`). Zero behavior change for existing bridge (WorkSurface) and broker (`/work-auth`) consumers.

## 2.4.0

### Minor Changes

- 661b5b8: Added support for standalone (non-iframe) work deployments via a new auth broker transport (`PopupBrokerTransport`). Works can now run on their own origin and open a Cohub broker popup for auth, authorization, and purchase — with a ready-handshake and one-shot `window.close()`.

  - **New exports**: `PopupBrokerTransport`, `resolveWorkTransport`, `WorkRuntimeModeConfig`.
  - **`CohubClientOptions.work`**: configure `mode: "broker" | "bridge"`, `brokerOrigin`, and `workId`. Auto-detection falls back to bridge when in an iframe.
  - **Token persistence**: `WorkRuntimeApi` now caches restricted tokens in `localStorage` when a `workId` is provided, surviving page reloads; `forceRefresh` clears the cache.
  - **`WorksApi.getPublicById(id)`**: loads a published work's metadata by id without requiring space membership.
  - Non-interactive messages (`context`, `checkout-state`) are answered locally in broker mode without opening a popup.

## 2.3.0

### Minor Changes

- ace4b41: Ship pending SDK changes accumulated since 2.2.1 that the CLI already
  consumes (references, label patching) and must release together.

  - **feat: resource reference index** — add `ReferencesApi` exposed as
    `cohub.references` on both `CohubClient` and `CohubHttpClient`. `query()`
    lists references touching a resource (space/session/checkpoint); `aggregate()`
    returns grouped counts for a space. Plus the full `Reference*` type set
    (`ReferenceQueryableType`, `ReferenceKind`, `ReferenceDirection`,
    `ReferenceAggregateGroupBy`, `ReferenceRecord`, …).
  - **feat: incremental resource label patching** — add
    `SpaceLabelsApi.patchResourceLabels(resourceType, resourceRef, { addLabelRefs,
removeLabelRefs })` returning `{ labels, assignments, changed }`, alongside the
    existing full `setResourceLabels`. Adds `PatchResourceLabelsInput` /
    `PatchResourceLabelsResponse` types.
  - **feat: local sandbox provider** — add `SpaceSandboxProvider` (`"cloud" |
"local"`) on `SpaceSandboxConfig` / `SpaceConfigInput` / `SpaceSandboxRecord`
    so spaces can declare a local sandbox provider.
  - **feat: session auto-compact** — extend `CreateSpacePromptInput.intent` with
    `"compact"` for agent-driven context compaction.
  - **fix: each_key_duplicate crash in generation stream** — merge intermediate
    messages that share a `tool_use.id` but landed under different dedupe keys
    (ordinal-keyed snapshot path vs id-keyed persisted-message path), as
    defense-in-depth for records lacking `meta.messageOrdinal`.

## 2.2.1

### Patch Changes

- 7907e1d: Show buyer profiles on commerce orders and enforce the minimum product price.

## 2.2.0

### Minor Changes

- 2a29102: Add credit benefits and consumption to work commerce, closing the monetization loop.

  - Add virtual `cohub_credit` token type and `work.consumption` usage type to billing declarations. Credit amounts are plain integers at business scope — creators never see token types.
  - Add `createBusinessBillingOperations` / `createDisabledBusinessBillingOperations` for business-scoped entitlement lookups, credit status, and credit consumption. Shares the same credit mapping helpers as platform billing so the two never drift.
  - Space commerce now supports `credits` benefit type (amount + optional expiry). Token type, scope, and grant kind are fixed and hidden from creators.
  - Product serialization fills `display.creditBenefits` from bound credit benefits so Works can show "includes 500 credits".
  - Work commerce replaces `POST entitlements/check` with `GET entitlements` — one call returns feature entitlements and credit balance. Adds `POST credits/consume` with idempotent `operationId`.
  - SDK `cohub.work.commerce` gains `getEntitlements()` and `consumeCredits()`, replacing `checkEntitlements()`.
  - CLI `works commerce` gains `entitlements` and `credits consume` commands; `spaces commerce benefits create` gains `--type credits --amount`.
  - Web benefit editor supports both feature and credits types.

- 2a29102: Add SDK commerce APIs for Spaces and Works.

  - Add `cohub.work.commerce` helpers for product resolution, entitlement checks, checkout creation, checkout state lookup, and order retrieval inside published Works.
  - Expand Space commerce SDK APIs and types for products, benefits, bindings, and recent orders so Space-level commerce management is fully scriptable.
  - Improve transport and error handling for uninitialized commerce setups.

## 2.1.0

### Minor Changes

- 5220dc0: Gate space commerce management behind dedicated permissions and a Max/Internal entitlement.

  - Add `space.commerce.view` / `space.commerce.manage` permissions (host only), replacing `space.edit` on commerce routes so commerce access is decoupled from content editing.
  - Add the `space.commerce` billing feature; setup and product/benefit configuration now require an active entitlement (granted by Max and Internal plans). Reads remain permission-gated only.
  - 402 responses carry a `feature_not_entitled` billing conversion intent so the shared upgrade UI can present plan options. Add `createFeatureGateConversionIntent` helper for reuse by future entitlement gates.

## 2.0.0

### Major Changes

- f853227: Rework work publishing around explicit visibility and version publication.

  SDK breaking changes: remove the `draft` work status and `publishVersion` update flag, add `WorkVisibility` on work create/update records, add `WorksApi.publishVersion()`, and slim `WorkVersionRecord` fields to match the API response.

  CLI breaking changes: remove draft status flags and `cohub works update --publish-version`, replace version publication with `cohub works publish-version`, add work visibility controls, and support role-qualified generation media inputs.

## 1.34.0

### Minor Changes

- Add Space default resolution and presence APIs, including presence snapshots, websocket presence updates, and `presence.updated` events.

## 1.33.1

### Patch Changes

- 1caff2c: Fix realtime room routing in the websocket SDK and keep the package publish flow aligned with the updated gateway routing.

## 1.33.0

### Minor Changes

- a8c3181: Release enriched work responses, mod prompt templates, streaming snapshot recovery fixes, and Cohub Ask rendering updates.

## 1.32.0

### Minor Changes

- Add generation stream snapshot recovery APIs, improve active generation resume behavior, and polish workspace preview interactions with immersive preview, per-session composer drafts, Mermaid touch zoom, and mobile member role controls.

## 1.31.0

### Minor Changes

- 3936634: Add SDK and CLI support for work presentation metadata, including Cohub bar visibility controls, and expose billing feature entitlement checks.

## 1.30.0

### Minor Changes

- 8455e51: Add `UserApi.listSessions()` for paginated cross-space session listing and `UserApi.getUsage(days)` for aggregated account-level usage. New permission scopes: `user.space.list`, `user.session.list`, `user.usage.read`.

## 1.29.0

### Minor Changes

- 4393131: Add `env` field to `CreateSpacePromptInput` and `SendMessageCronJobPayload` for prompt-scoped environment variables.
- 4393131: Enhance `CheckpointRecord` type with optional `rootCheckpointId` and `saveVersion` fields, and make `meta` optional.
- 4393131: Add WeChat channel login methods `startWeChatLogin()` and `waitWeChatLogin()` on `ChannelsApi`, with optional verify code flow support.

## 1.28.2

### Patch Changes

- Release work management, public asset, and CLI attachment updates.

## 1.28.1

### Patch Changes

- Release checkpoint pagination and work runtime stability fixes.

## 1.28.0

### Minor Changes

- e79488b: Add generation.create permission
- e79488b: Add works management APIs (get, update, delete) and WorkUpdateInput type

## 1.27.1

### Patch Changes

- Release the SDK with the latest updates.

## 1.27.0

### Minor Changes

- 9a523d0: Refactor billing API: replace `getUsageRecords` / `getOverages` with unified `getBalanceActivities`, replace `purchaseAddon` / `subscribePlan` with `createOrder` / `createSubscription`, add `createRedemption`, remove `getOrders` / `cancelOrderCheckout`, and update `cancelSubscriptionCheckout` / `cancelSubscriptionAutoRenew` method signatures. Remove related legacy types.
- 9a523d0: Remove `SessionMessagesClient.send()` method and related `SessionSendMessageInput` type. Messages are now sent exclusively through the websocket-based generation stream API.

## 1.26.0

### Minor Changes

- Release scheduled job management updates, including SDK support for cron job detail, patch updates, and paginated run listing, plus CLI commands for scheduled job inspection and updates.

## 1.25.2

### Patch Changes

- Publish work sharing and publishing updates.

## 1.25.1

### Patch Changes

- Expose the existing checkpoint save response flag in the SDK type.

## 1.25.0

### Minor Changes

- Add checkpoint file browsing APIs and CLI support, plus Suno music generation compatibility.

## 1.24.0

### Minor Changes

- Release v1.49.0 with realtime canvas persistence and operation sync, space layout customization, custom space styles, label-scoped search, guest prompt access hardening, loading state refinements, and turn navigator polish.

## 1.23.1

### Patch Changes

- Expose generation waiting lifecycle updates and refine runtime status rendering.

## 1.23.0

### Minor Changes

- Release v1.48.0 with background task controls, billing account expansion, session queue stability, active label highlighting, file preview support, and agent wakeup hardening.

## 1.22.0

### Minor Changes

- Add browser voice input support with Volc ASR, including the new `voice-input` SDK export, realtime WebSocket reuse during idle periods, and related split-view stability fixes.

## 1.21.0

### Minor Changes

- Release label refs in prompts, automatic session source labels, label item management, and CLI label command updates.

## 1.20.0

### Minor Changes

- Release billing balance details, billing plans and redemption flow, and label-based space organization APIs.

## 1.19.0

### Minor Changes

- 2312811: Release Mirror updates with read-only prompt access, shared session visibility improvements, and session participant metadata.

## 1.18.1

### Patch Changes

- 1ade102: Publish npm packages for the latest release.

## 1.18.0

### Minor Changes

- ce0e5fb: Expose generation policy helpers and metadata propagation for session generation tasks.

  Add CLI-side generation policy enforcement from environment variables and filter model listings accordingly.

## 1.17.0

### Minor Changes

- 1f860ba: Clean up legacy realtime turn progress/snapshot events and add session/task lifecycle realtime events.

## 1.16.1

### Patch Changes

- 884b3d0: feat(cli): improve generation task feedback and output labels; fix fetch failure diagnostics and surface generation provider details; upgrade neta generation to 0.1.2

## 1.16.0

### Minor Changes

- 109cf4d: feat: add multimodal model show command, billing credits integration, and async task refactor

  - Add multimodal model show command for CLI
  - Integrate billing credits support
  - Refactor generations to async tasks
  - Fix CLI auth, space defaults, and JSON output flag
  - Recover from transient unauthorized responses

## 1.15.1

### Patch Changes

- 02519c6: Restore named space mod mounts and sandbox restart metadata in the SDK and CLI.

## 1.15.0

### Minor Changes

- 133275c: Release SDK support for public asset uploads, space slugs, space public profiles, and default space mods.

  Release CLI avatar upload commands for user and space profiles, plus updated space mod management output.

## 1.14.0

### Minor Changes

- 872b08c: Add timing tracking for session messages and turns, expose persisted duration metadata in SDK streams, and add run command support for space sandboxes via new SDK API.

## 1.13.1

### Patch Changes

- fc1dc64: Update sandbox upload materialization types and CLI space handling.

## 1.13.0

### Minor Changes

- 48bdf1b: Add SDK and CLI support for usernames, sectioned Explore spaces, space pins, and sandbox lifecycle controls.

## 1.12.0

### Minor Changes

- Expose space access permissions in the SDK and improve CLI/API error messages.

## 1.11.0

### Minor Changes

- 4eed38f: Add space mod APIs and CLI commands.

## 1.10.2

### Patch Changes

- bfe50bf: update eventstream logging

## 1.10.1

### Patch Changes

- 3846078: Add a tree-shakeable debugger subpath for browser-side console and network collection, with JSON log and HAR export helpers.

## 1.10.0

### Minor Changes

- 78a111b: Publish the latest SDK, CLI, and web updates, including space file upload support, refreshed realtime protocol handling, batch file APIs, command palette and streaming tool call UI improvements, and package build tooling improvements.

## 1.9.0

### Minor Changes

- 31f5713: Release updated protocol, SDK, and CLI packages.

  - Rename generation model listing response types to match the `/api/models?modelType=multimodal` API shape.
  - Add SDK helpers for multimodal models and search access.
  - Improve CLI auth flow, search commands, command help, and self-update behavior.

### Patch Changes

- Updated dependencies [31f5713]
  - @cohub/protocol@2.0.0

## 1.8.0

### Minor Changes

- Add multimodal generation protocol types, SDK APIs, and CLI commands.

### Patch Changes

- Updated dependencies
  - @cohub/protocol@1.6.0

## 1.7.1

### Patch Changes

- 4e62670: Make `session.subscribeGeneration(...)` keep independent stream reducer state per subscription, preventing cached session clients from sharing generation progress, patch, and intermediate-message state across repeated subscribers.

## 1.7.0

### Minor Changes

- c53aaec: Introduce SessionGenerationStreamClient and normalized generation subscription, redesign session fork architecture with segment-based turns

### Patch Changes

- Updated dependencies [c53aaec]
  - @cohub/protocol@1.5.0

## 1.6.0

### Minor Changes

- 341bfc0: Add turn abort/steer reason, continuedByTurnId to turn summary; add turnId/userMessageId to websocket events
- Add `SessionGenerationStreamClient` and `session.subscribeGeneration(...)` for normalized generation events across turn patches, persisted assistant commits, finalized turns, and errors.

### Patch Changes

- Updated dependencies [341bfc0]
  - @cohub/protocol@1.4.0

## 1.5.1

### Patch Changes

- c469fb2: Fix websocket compact stream buffering after reconnecting into an active session turn from a snapshot.

## 1.5.0

### Minor Changes

- c688cc5: feat: unified space prompt scheduling, session patch stream isolation, and SDK/CLI improvements

  - Add unified space prompt scheduling with `CreateSpacePromptInput` and `clientMessageId` support
  - Add `getSessionTurnPatchStreamKey()` to isolate session patch streams by message
  - Add `sourceMessageId` and `messageOrdinal` fields to `SessionTurnPatchEvent`
  - SDK: add spaces API, update tasks/cron-jobs APIs, extend types, simplify websocket stream logic
  - CLI: add spaces commands, update cron-jobs/tasks commands
  - Clean up stale `.d.ts`/`.js` artifacts from protocol source directory

### Patch Changes

- Updated dependencies [c688cc5]
  - @cohub/protocol@1.3.0

## 1.4.0

### Minor Changes

- d5b8d41: - `SessionPatchReducer`：支持对 `/message/content/blocks/{n}/...` 下任意 JSON 子路径的 `append`（字符串前缀追加）与 `replace`（深度赋值），不再仅识别 `text` / `thinking` 等固定路径。
  - 开发用 `tsconfig`：为 `@cohub/protocol/ports` 增加 `paths` 映射，修复 typecheck 无法解析该子路径的问题；`tsconfig.build.json` 同步增加 `ports` 的 dist 映射以便构建。

## 1.3.1

### Patch Changes

- Release current package updates.
- Updated dependencies
  - @cohub/protocol@1.2.3

## 1.3.0

### Minor Changes

- f469947: Add SDK support for explore spaces, space profile and pinned-resource APIs, sandbox status/ports/recreate APIs, session turn pagination/index/window/detail/signed-url APIs, authenticated file downloads, user rules, and raw/blob transport helpers.

  Improve realtime handling with turn updated/finalized and ports changed events, plus buffered out-of-order patch frames for more reliable compact streams.

## 1.2.2

### Patch Changes

- a2cb8ff: 现在在刷新会话页面时会自动接续未完成的 stream
- Updated dependencies [a2cb8ff]
  - @cohub/protocol@1.2.2

## 1.2.1

### Patch Changes

- 66b4ef8: Add lightweight WebSocket compact frames for session patch streaming, with SDK negotiation and decoding support.
- Updated dependencies [66b4ef8]
  - @cohub/protocol@1.2.1

## 1.2.0

### Minor Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.

### Patch Changes

- Updated dependencies [0797485]
  - @cohub/protocol@1.2.0
