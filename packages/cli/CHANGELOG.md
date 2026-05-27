# @neta-art/cohub-cli

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
