# @neta-art/cohub-protocol

## 1.2.4

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

## 1.2.3

### Patch Changes

- Release current package updates.

## 1.2.2

### Patch Changes

- a2cb8ff: 现在在刷新会话页面时会自动接续未完成的 stream

## 1.2.1

### Patch Changes

- 66b4ef8: Add lightweight WebSocket compact frames for session patch streaming, with SDK negotiation and decoding support.

## 1.2.0

### Minor Changes

- 0797485: Add environment-aware SDK and CLI defaults for production and development Cohub endpoints, and publish updated protocol filesystem realtime types.
