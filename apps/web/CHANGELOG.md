# web

## 0.1.37

### Patch Changes

- Updated dependencies [3936634]
  - @neta-art/cohub@1.31.0

## 0.1.36

### Patch Changes

- Updated dependencies [8455e51]
  - @neta-art/cohub@1.30.0

## 0.1.35

### Patch Changes

- Updated dependencies [4393131]
- Updated dependencies [4393131]
- Updated dependencies [4393131]
  - @neta-art/cohub@1.29.0

## 0.1.34

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.28.2

## 0.1.33

### Patch Changes

- Updated dependencies [e79488b]
- Updated dependencies [e79488b]
  - @neta-art/cohub@1.28.0

## 0.1.32

### Patch Changes

- ccd15dd: Fix space page stuck in loading by adopting stale-while-revalidate for bootstrap cache

  - Start remote `/api/spaces/:id` request immediately instead of blocking on IndexedDB cache reads
  - Add 180ms timeout to bootstrap cache reads so slow/hanging IndexedDB never blocks the page
  - Guard against stale cache overwriting fresh remote data
  - Make session list cache always revalidate against remote even when local cache exists
  - Log session list refresh failures instead of silently swallowing errors

- Updated dependencies [9a523d0]
- Updated dependencies [9a523d0]
  - @neta-art/cohub@1.27.0

## 0.1.31

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.26.0

## 0.1.30

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.2

## 0.1.29

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.1

## 0.1.28

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.25.0

## 0.1.27

### Patch Changes

- Release v1.49.0 with realtime canvas persistence and operation sync, space layout customization, custom space styles, label-scoped search, guest prompt access hardening, loading state refinements, and turn navigator polish.
- Updated dependencies
  - @neta-art/cohub@1.24.0

## 0.1.26

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.1

## 0.1.25

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.23.0

## 0.1.24

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.22.0

## 0.1.23

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.21.0

## 0.1.22

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.20.0

## 0.1.21

### Patch Changes

- Updated dependencies [2312811]
  - @neta-art/cohub@1.19.0

## 0.1.20

### Patch Changes

- Updated dependencies [1ade102]
  - @neta-art/cohub@1.18.1

## 0.1.19

### Patch Changes

- Updated dependencies [ce0e5fb]
  - @neta-art/cohub@1.18.0

## 0.1.18

### Patch Changes

- Updated dependencies [1f860ba]
  - @neta-art/cohub@1.17.0

## 0.1.17

### Patch Changes

- Updated dependencies [884b3d0]
  - @neta-art/cohub@1.16.1

## 0.1.16

### Patch Changes

- Updated dependencies [109cf4d]
  - @neta-art/cohub@1.16.0

## 0.1.15

### Patch Changes

- Updated dependencies [02519c6]
  - @neta-art/cohub@1.15.1

## 0.1.14

### Patch Changes

- Updated dependencies [133275c]
  - @neta-art/cohub@1.15.0

## 0.1.13

### Patch Changes

- Updated dependencies [872b08c]
  - @neta-art/cohub@1.14.0

## 0.1.12

### Patch Changes

- Updated dependencies [fc1dc64]
  - @neta-art/cohub@1.13.1

## 0.1.11

### Patch Changes

- Updated dependencies [48bdf1b]
  - @neta-art/cohub@1.13.0

## 0.1.10

### Patch Changes

- Updated dependencies
  - @neta-art/cohub@1.12.0

## 0.1.9

### Patch Changes

- Updated dependencies [4eed38f]
  - @neta-art/cohub@1.11.0

## 0.1.8

### Patch Changes

- Updated dependencies [bfe50bf]
  - @neta-art/cohub@1.10.2

## 0.1.7

### Patch Changes

- Updated dependencies [3846078]
  - @neta-art/cohub@1.10.1

## 0.1.6

### Patch Changes

- 78a111b: Publish the latest SDK, CLI, and web updates, including space file upload support, refreshed realtime protocol handling, batch file APIs, command palette and streaming tool call UI improvements, and package build tooling improvements.
- Updated dependencies [78a111b]
  - @neta-art/cohub@1.10.0

## 0.1.5

### Patch Changes

- Updated dependencies [31f5713]
  - @cohub/protocol@2.0.0
  - @neta-art/cohub@1.9.0

## 0.1.4

### Patch Changes

- Updated dependencies
  - @cohub/protocol@1.6.0
  - @neta-art/cohub@1.8.0

## 0.1.3

### Patch Changes

- Updated dependencies [4e62670]
  - @neta-art/cohub@1.7.1

## 0.1.2

### Patch Changes

- Updated dependencies [c53aaec]
- Updated dependencies [c53aaec]
  - @neta-art/cohub@1.7.0
  - @cohub/protocol@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [341bfc0]
  - @cohub/protocol@1.4.0
  - @neta-art/cohub@1.6.0

## 0.1.0

### Minor Changes

- Stream partial tool execution results to UI in real time, with phase-aware visual feedback for running tool calls. Fix stream snapshot restoration and enrich with DB intermediate metadata. Improve fs watch ignore patterns and stabilize streaming markdown fences.

## 0.0.8

### Patch Changes

- Updated dependencies [c469fb2]
  - @neta-art/cohub@1.5.1

## 0.0.7

### Patch Changes

- Updated dependencies [c688cc5]
  - @cohub/protocol@1.3.0
  - @neta-art/cohub@1.5.0

## 0.0.6

### Patch Changes

- Updated dependencies [d5b8d41]
  - @neta-art/cohub@1.4.0

## 0.0.5

### Patch Changes

- Updated dependencies [f469947]
  - @neta-art/cohub@1.3.0

## 0.0.4

### Patch Changes

- Updated dependencies [a2cb8ff]
  - @cohub/protocol@1.2.2
  - @neta-art/cohub@1.2.2

## 0.0.3

### Patch Changes

- Updated dependencies [66b4ef8]
  - @neta-art/cohub@1.2.1
  - @cohub/protocol@1.2.1

## 0.0.2

### Patch Changes

- Updated dependencies [0797485]
  - @cohub/protocol@1.2.0
  - @neta-art/cohub@1.2.0
