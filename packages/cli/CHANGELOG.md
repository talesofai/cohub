# @neta-art/cohub-cli

## 2.6.1

### Patch Changes

- dad311e: Recover WebSocket sessions from a transient authentication failure by forcing one access-token refresh, reconnecting once, and restoring room subscriptions without entering an infinite retry loop.
- Updated dependencies [dad311e]
  - @neta-art/cohub@2.14.1

## 2.6.0

### Minor Changes

- f72fa82: Expose structured canvas transaction conflicts and richer published Work metadata through the Cohub SDK and CLI dependency bundle.

  - Export `CanvasTransactionError` with status, code, and `isVersionConflict` so clients can rebase and retry rejected canvas transactions.
  - Add `lang` and `themeColor` to published Work metadata types.

### Patch Changes

- Updated dependencies [f72fa82]
  - @neta-art/cohub@2.14.0

## 2.5.1

### Patch Changes

- Upgrade `@neta-art/generation` dependency to `^0.1.16`.

## 2.5.0

### Minor Changes

- Carry request provenance via `X-Cohub-Source-*` headers for cross-space traceability.

  - **SDK**: `requestSource` on client options (static or per-request getter); transport stamps `X-Cohub-Source-*` automatically; re-export provenance helpers (`readRequestSourceFromEnv`, `requestSourceToHeaders`, `mergeRequestSourceIntoMeta`, …).
  - **CLI**: every request sends `via: cli` and sandbox `COHUB_*` identity when present; drop ad-hoc `meta.source` / `versionMeta` / `meta.cohub` merge on works and generations.
  - **Breaking note**: `WorkCreateInput.versionMeta` removed — publish provenance is taken from request headers instead.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@2.13.0

## 2.4.0

### Minor Changes

- d21c200: Ship the resource-references graph-edge model and empty-account Home space bootstrap that the API and agent already expose.

  - **feat(references): graph-edge model with agent file access stats** — turn-level sources, file targets, and agent tool file kinds (`agent_tool_file_read|write|edit|ls|find|grep`); drop redundant `participant` edges; `ReferenceRecord` uses `sourceSpaceId` / `sourceSessionId`; aggregate supports `groupBy=target` and `limit`.
  - **feat: auto-create Home space for empty accounts** — `spaces.getDefault()` creates a blank Home space (`slug=home`) when the account has no accessible space.
  - **CLI**: `references query` accepts `turn:<uuid>`; aggregate `--group-by target` / `--limit`; file targets render as short space id + path.

### Patch Changes

- Updated dependencies [d21c200]
  - @neta-art/cohub@2.12.0

## 2.3.3

### Patch Changes

- 1d27866: Stop silent SSO login callback redirect loops by letting bootstrap `getMe` skip the unauthorized handler, and ship Apache-2.0 LICENSE/NOTICE with the published packages.
- Updated dependencies [1d27866]
  - @neta-art/cohub@2.11.2

## 2.3.2

### Patch Changes

- 43b7653: Record optional provenance on work versions via `meta` (CLI auto-fills `source` from COHUB\_\* env).
- Updated dependencies [43b7653]
  - @neta-art/cohub@2.11.1

## 2.3.1

### Patch Changes

- 6c0b75f: Add durable chat attachments that no longer require a session.

  SDK: `publicAssets.uploadChatAttachment()` for any file mime, optional `spaceId`/`sessionId` association only, and space upload `downloadUrl` materialize (skip client PUT when the file is already a durable public asset). `sandbox_tmp` destination `sessionId` is optional; plan entries may omit `uploadUrl`/`objectKey` for remote sources.

  CLI: `spaces prompt --image` works without `--session`; file upload complete skips remote `downloadUrl` entries that the server pulls itself.

- 86e11a7: Expose generation model discount billing details in SDK results and CLI output.
- Updated dependencies [6c0b75f]
- Updated dependencies [86e11a7]
  - @neta-art/cohub@2.11.0

## 2.3.0

### Minor Changes

- a45d3e8: Add referral links, account referral management, and CLI referral commands.

### Patch Changes

- Updated dependencies [a45d3e8]
  - @neta-art/cohub@2.10.0

## 2.2.10

### Patch Changes

- 74a3b9d: Add raw space LLM completions that skip the agent turn queue. Callers fully control message history and an optional space-relative system prompt file.

  SDK: `space.completion()` (JSON) and `space.streamCompletion()` (SSE deltas with abort-safe streaming).
  CLI: `cohub completion` / `cohub spaces completion` with `--stream`, `--system-prompt`, model/provider, temperature, max tokens, and thinking level.

- Updated dependencies [74a3b9d]
  - @neta-art/cohub@2.9.0

## 2.2.9

### Patch Changes

- 10989f6: Record multimodal generation usage against the shared credit balance after successful provider calls. Add `generation.music` usage type, resolve image/video/music kinds for billing gates, and surface post-success `billing` metadata on generation task results.

  Also add hourly generation usage stats (mirroring LLM token rollups) so multimodal usage appears in trending and usage endpoints.

- 9188401: Unify billing gate responses. Every billing-gated 402 (negative balance limit and plan entitlement) now returns a flat `{ code, message, billing: { conversion, status?, netUsd?, hardNegativeLimitUsd? } }` body, and soft debt warnings ride the same `billing` payload on success responses. The SDK adds `BILLING_ACCESS_BLOCKED_ERROR_CODE`, `isBillingAccessBlockedError`, `isBillingAccessBlockedCode`, `extractBillingPayload`, and a `BillingResponsePayload` type so clients extract the conversion intent with one call. Websocket `session.request.error` events now carry the same `billing` payload. The CLI surfaces the conversion title/message on 402.
- Updated dependencies [4c28633]
- Updated dependencies [10989f6]
- Updated dependencies [9188401]
  - @neta-art/cohub@2.8.0

## 2.2.8

### Patch Changes

- Updated dependencies [55eeac2]
  - @neta-art/cohub@2.7.1

## 2.2.7

### Patch Changes

- Updated dependencies [348f62a]
  - @neta-art/cohub@2.7.0

## 2.2.6

### Patch Changes

- Updated dependencies [805d300]
  - @neta-art/cohub@2.6.0

## 2.2.5

### Patch Changes

- Updated dependencies [1fe514d]
  - @neta-art/cohub@2.5.0

## 2.2.4

### Patch Changes

- Updated dependencies [661b5b8]
  - @neta-art/cohub@2.4.0

## 2.2.3

### Patch Changes

- e854b0e: Bump the pinned `sandboxd` binary version to v1.82.4, which includes the local
  sandbox `/workspace` path mapping fix.

## 2.2.2

### Patch Changes

- ce4fc3c: Bump the pinned `sandboxd` binary version to v1.82.2. This is the first
  release whose archives were actually published to the public CDN — the
  `publish-cdn` job had been failing on every tag since the managed-download
  workflow landed, so the previous pin (v1.80.2) 404'd on download. With this
  bump, `sandbox up` resolves a version that exists on the CDN.
- Updated dependencies [ace4b41]
  - @neta-art/cohub@2.3.0

## 2.2.1

### Patch Changes

- 7907e1d: Show buyer profiles on commerce orders and enforce the minimum product price.
- Updated dependencies [7907e1d]
  - @neta-art/cohub@2.2.1

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

### Patch Changes

- Updated dependencies [2a29102]
- Updated dependencies [2a29102]
  - @neta-art/cohub@2.2.0

## 2.1.0

### Minor Changes

- ba31079: Expand CLI commerce support.

  - Replace the compact space commerce commands with explicit product, benefit, bind, unbind, and paginated order subcommands under `cohub spaces commerce`.
  - Add work commerce debugging commands under `cohub works commerce` for product resolution, entitlement checks, checkout creation, and order lookup.

### Patch Changes

- Updated dependencies [5220dc0]
  - @neta-art/cohub@2.1.0

## 2.0.0

### Major Changes

- f853227: Rework work publishing around explicit visibility and version publication.

  SDK breaking changes: remove the `draft` work status and `publishVersion` update flag, add `WorkVisibility` on work create/update records, add `WorksApi.publishVersion()`, and slim `WorkVersionRecord` fields to match the API response.

  CLI breaking changes: remove draft status flags and `cohub works update --publish-version`, replace version publication with `cohub works publish-version`, add work visibility controls, and support role-qualified generation media inputs.

### Patch Changes

- Updated dependencies [f853227]
  - @neta-art/cohub@2.0.0

## 1.20.6

### Patch Changes

- Add Space default resolution and presence APIs, including presence snapshots, websocket presence updates, and `presence.updated` events.
- Updated dependencies
  - @neta-art/cohub@1.34.0

## 1.20.5

### Patch Changes

- Updated dependencies [1caff2c]
  - @neta-art/cohub@1.33.1

## 1.20.4

### Patch Changes

- a8c3181: Release enriched work responses, mod prompt templates, streaming snapshot recovery fixes, and Cohub Ask rendering updates.
- Updated dependencies [a8c3181]
  - @neta-art/cohub@1.33.0

## 1.20.3

### Patch Changes

- 6eee05e: Show Space slugs in CLI output and allow `spaces get` to use the configured target Space.

## 1.20.2

### Patch Changes

- 20a4cc1: Add CLI commands for updating profile usernames and Space slugs.

## 1.20.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.32.0

## 1.20.0

### Minor Changes

- 3936634: Add SDK and CLI support for work presentation metadata, including Cohub bar visibility controls, and expose billing feature entitlement checks.

### Patch Changes

- Updated dependencies [3936634]
  - @neta-art/cohub@1.31.0

## 1.19.0

### Minor Changes

- 8455e51: Add `cohub me sessions` (paginated cross-space session list) and `cohub me usage [days]` (aggregated account-level usage summary) commands. Update `--work-scope` / `--viewer-scope` help text with full valid scope values including new user-level scopes.

### Patch Changes

- Updated dependencies [8455e51]
  - @neta-art/cohub@1.30.0

## 1.18.0

### Minor Changes

- 4393131: Add `--env` option to `prompt` and `spaces send` commands for setting per-turn environment variables. Use `--env KEY=value` and repeat for multiple variables.

### Patch Changes

- Updated dependencies [4393131]
- Updated dependencies [4393131]
- Updated dependencies [4393131]
  - @neta-art/cohub@1.29.0

## 1.17.5

### Patch Changes

- Release work management, public asset, and CLI attachment updates.
- Updated dependencies
  - @neta-art/cohub@1.28.2

## 1.17.4

### Patch Changes

- Release checkpoint pagination and work runtime stability fixes.
- Updated dependencies
  - @neta-art/cohub@1.28.1

## 1.17.3

### Patch Changes

- Updated dependencies [e79488b]
- Updated dependencies [e79488b]
  - @neta-art/cohub@1.28.0

## 1.17.2

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.27.1

## 1.17.1

### Patch Changes

- Release the CLI with the latest generation SDK dependency update.

## 1.17.0

### Minor Changes

- 9a523d0: Upgrade `@neta-art/generation` dependency to `^0.1.4`.

### Patch Changes

- Updated dependencies [9a523d0]
- Updated dependencies [9a523d0]
  - @neta-art/cohub@1.27.0

## 1.16.0

### Minor Changes

- Release scheduled job management updates, including SDK support for cron job detail, patch updates, and paginated run listing, plus CLI commands for scheduled job inspection and updates.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.26.0

## 1.15.2

### Patch Changes

- Publish work sharing and publishing updates.
- Updated dependencies
  - @neta-art/cohub@1.25.2

## 1.15.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.1

## 1.15.0

### Minor Changes

- Add checkpoint file browsing APIs and CLI support, plus Suno music generation compatibility.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.0

## 1.14.0

### Minor Changes

- Release v1.49.0 with realtime canvas persistence and operation sync, space layout customization, custom space styles, label-scoped search, guest prompt access hardening, loading state refinements, and turn navigator polish.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.24.0

## 1.13.1

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.1

## 1.13.0

### Minor Changes

- Release v1.48.0 with background task controls, billing account expansion, session queue stability, active label highlighting, file preview support, and agent wakeup hardening.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.0

## 1.12.1

### Patch Changes

- Add browser voice input support with Volc ASR, including the new `voice-input` SDK export, realtime WebSocket reuse during idle periods, and related split-view stability fixes.
- Updated dependencies
  - @neta-art/cohub@1.22.0

## 1.12.0

### Minor Changes

- Release label refs in prompts, automatic session source labels, label item management, and CLI label command updates.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.21.0

## 1.11.1

### Patch Changes

- Release billing balance details, billing plans and redemption flow, and label-based space organization APIs.
- Updated dependencies
  - @neta-art/cohub@1.20.0

## 1.11.0

### Minor Changes

- 2312811: Release Mirror updates with read-only prompt access, shared session visibility improvements, and session participant metadata.

### Patch Changes

- Updated dependencies [2312811]
  - @neta-art/cohub@1.19.0

## 1.10.1

### Patch Changes

- 1ade102: Publish npm packages for the latest release.
- Updated dependencies [1ade102]
  - @neta-art/cohub@1.18.1

## 1.10.0

### Minor Changes

- ce0e5fb: Expose generation policy helpers and metadata propagation for session generation tasks.

  Add CLI-side generation policy enforcement from environment variables and filter model listings accordingly.

### Patch Changes

- Updated dependencies [ce0e5fb]
  - @neta-art/cohub@1.18.0

## 1.9.1

### Patch Changes

- 1f860ba: Clean up legacy realtime turn progress/snapshot events and add session/task lifecycle realtime events.
- Updated dependencies [1f860ba]
  - @neta-art/cohub@1.17.0

## 1.9.0

### Minor Changes

- 884b3d0: feat(cli): improve generation task feedback and output labels; fix fetch failure diagnostics and surface generation provider details; upgrade neta generation to 0.1.2

### Patch Changes

- Updated dependencies [884b3d0]
  - @neta-art/cohub@1.16.1

## 1.8.0

### Minor Changes

- 109cf4d: feat: add multimodal model show command, billing credits integration, and async task refactor

  - Add multimodal model show command for CLI
  - Integrate billing credits support
  - Refactor generations to async tasks
  - Fix CLI auth, space defaults, and JSON output flag
  - Recover from transient unauthorized responses

### Patch Changes

- Updated dependencies [109cf4d]
  - @neta-art/cohub@1.16.0

## 1.7.1

### Patch Changes

- 02519c6: Restore named space mod mounts and sandbox restart metadata in the SDK and CLI.
- Updated dependencies [02519c6]
  - @neta-art/cohub@1.15.1

## 1.7.0

### Minor Changes

- 133275c: Release SDK support for public asset uploads, space slugs, space public profiles, and default space mods.

  Release CLI avatar upload commands for user and space profiles, plus updated space mod management output.

### Patch Changes

- Updated dependencies [133275c]
  - @neta-art/cohub@1.15.0

## 1.6.3

### Patch Changes

- 872b08c: Clear full auth session on 401 responses instead of only the device code, preventing stale tokens from causing repeated auth failures.
- Updated dependencies [872b08c]
  - @neta-art/cohub@1.14.0

## 1.6.2

### Patch Changes

- 8eb954c: Differentiate default sandbox idle TTL by environment (dev: 10m, prod: 12h).

## 1.6.1

### Patch Changes

- fc1dc64: Update sandbox upload materialization types and CLI space handling.
- Updated dependencies [fc1dc64]
  - @neta-art/cohub@1.13.1

## 1.6.0

### Minor Changes

- 48bdf1b: Add SDK and CLI support for usernames, sectioned Explore spaces, space pins, and sandbox lifecycle controls.

### Patch Changes

- Updated dependencies [48bdf1b]
  - @neta-art/cohub@1.13.0

## 1.5.1

### Patch Changes

- Expose space access permissions in the SDK and improve CLI/API error messages.
- Updated dependencies
  - @neta-art/cohub@1.12.0

## 1.5.0

### Minor Changes

- 4eed38f: Add space mod APIs and CLI commands.

### Patch Changes

- Updated dependencies [4eed38f]
  - @neta-art/cohub@1.11.0

## 1.4.2

### Patch Changes

- Updated dependencies [bfe50bf]
  - @neta-art/cohub@1.10.2

## 1.4.1

### Patch Changes

- Updated dependencies [3846078]
  - @neta-art/cohub@1.10.1

## 1.4.0

### Minor Changes

- 78a111b: Publish the latest SDK, CLI, and web updates, including space file upload support, refreshed realtime protocol handling, batch file APIs, command palette and streaming tool call UI improvements, and package build tooling improvements.

### Patch Changes

- Updated dependencies [78a111b]
  - @neta-art/cohub@1.10.0

## 1.3.0

### Minor Changes

- 31f5713: Release updated protocol, SDK, and CLI packages.

  - Rename generation model listing response types to match the `/api/models?modelType=multimodal` API shape.
  - Add SDK helpers for multimodal models and search access.
  - Improve CLI auth flow, search commands, command help, and self-update behavior.

### Patch Changes

- Updated dependencies [31f5713]
  - @neta-art/cohub@1.9.0

## 1.2.0

### Minor Changes

- Add multimodal generation protocol types, SDK APIs, and CLI commands.

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.8.0

## 1.1.4

### Patch Changes

- Updated dependencies [4e62670]
  - @neta-art/cohub@1.7.1

## 1.1.3

### Patch Changes

- Updated dependencies [c53aaec]
  - @neta-art/cohub@1.7.0

## 1.1.2

### Patch Changes

- 341bfc0: Add turn abort/steer reason, continuedByTurnId to turn summary; add turnId/userMessageId to websocket events
- Updated dependencies [341bfc0]
  - @neta-art/cohub@1.6.0

## 1.1.1

### Patch Changes

- Updated dependencies [c469fb2]
  - @neta-art/cohub@1.5.1

## 1.1.0

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
  - @neta-art/cohub@1.5.0

## 1.0.6

### Patch Changes

- Updated dependencies [d5b8d41]
  - @neta-art/cohub@1.4.0

## 1.0.5

### Patch Changes

- Release current package updates.
- Updated dependencies
  - @neta-art/cohub@1.3.1

## 1.0.4

### Patch Changes

- Updated dependencies [f469947]
  - @neta-art/cohub@1.3.0

## 1.0.3

### Patch Changes

- Updated dependencies [a2cb8ff]
  - @neta-art/cohub@1.2.2

## 1.0.2

### Patch Changes

- Updated dependencies [66b4ef8]
  - @neta-art/cohub@1.2.1

## 1.0.1

### Patch Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.
- Updated dependencies [0797485]
  - @neta-art/cohub@1.2.0
