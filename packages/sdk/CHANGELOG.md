# @neta-art/cohub

## 1.4.1

### Patch Changes

- a2120ec: fix: isolate session patch streams by message

  Add `getSessionTurnPatchStreamKey()` to derive a deterministic stream key from
  turn, message, or session identity, ensuring patch operations are scoped to the
  correct stream. Add `sourceMessageId` and `messageOrdinal` fields to
  `SessionTurnPatchEvent` for richer patch identity resolution. Clean up stale
  `.d.ts` / `.js` artifacts from protocol source directory.

  SDK `WebsocketClient` now uses the shared `getSessionTurnPatchStreamKey()`
  instead of inline fallback logic. Add `clientMessageId` to
  `SessionSendMessageInput` and `CreateSpacePromptInput` for better
  client-side message correlation.

- Updated dependencies [a2120ec]
  - @neta-art/cohub-protocol@1.2.4

## 1.4.0

### Minor Changes

- d5b8d41: - `SessionPatchReducer`：支持对 `/message/content/blocks/{n}/...` 下任意 JSON 子路径的 `append`（字符串前缀追加）与 `replace`（深度赋值），不再仅识别 `text` / `thinking` 等固定路径。
  - 开发用 `tsconfig`：为 `@neta-art/cohub-protocol/ports` 增加 `paths` 映射，修复 typecheck 无法解析该子路径的问题；`tsconfig.build.json` 同步增加 `ports` 的 dist 映射以便构建。

## 1.3.1

### Patch Changes

- Release current package updates.
- Updated dependencies
  - @neta-art/cohub-protocol@1.2.3

## 1.3.0

### Minor Changes

- f469947: Add SDK support for explore spaces, space profile and pinned-resource APIs, sandbox status/ports/recreate APIs, session turn pagination/index/window/detail/signed-url APIs, authenticated file downloads, user rules, and raw/blob transport helpers.

  Improve realtime handling with turn snapshot/updated/finalized and ports changed events, plus buffered out-of-order patch frames for more reliable compact streams.

## 1.2.2

### Patch Changes

- a2cb8ff: 现在在刷新会话页面时会自动接续未完成的 stream
- Updated dependencies [a2cb8ff]
  - @neta-art/cohub-protocol@1.2.2

## 1.2.1

### Patch Changes

- 66b4ef8: Add lightweight WebSocket compact frames for session patch streaming, with SDK negotiation and decoding support.
- Updated dependencies [66b4ef8]
  - @neta-art/cohub-protocol@1.2.1

## 1.2.0

### Minor Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.

### Patch Changes

- Updated dependencies [0797485]
  - @neta-art/cohub-protocol@1.2.0
