# @neta-art/cohub

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
