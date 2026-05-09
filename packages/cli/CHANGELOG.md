# @neta-art/cohub-cli

## 1.1.0

### Minor Changes

- feat: unified space prompt scheduling, session patch stream isolation, and SDK/CLI improvements

  - Add unified space prompt scheduling with `CreateSpacePromptInput` and `clientMessageId` support
  - Add `getSessionTurnPatchStreamKey()` to derive deterministic stream keys, isolating session patch streams by message
  - Add `sourceMessageId` and `messageOrdinal` fields to `SessionTurnPatchEvent`
  - SDK: add spaces API, update tasks/cron-jobs APIs, extend types, simplify websocket stream logic
  - CLI: add spaces commands, update cron-jobs/tasks commands
  - Clean up stale `.d.ts`/`.js` artifacts from protocol source directory

### Patch Changes

- Updated dependencies
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
