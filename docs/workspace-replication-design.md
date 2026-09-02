# CoHub Workspace Replication Design

Status: implemented behind rollout flags; production integration validation pending
Date: 2026-08-26

> For local provider session execution, [Local ACP Runtime Architecture](./local-acp-runtime-architecture.md) is normative. Native hook/ingest mirroring described in older sections is legacy compatibility; ACP `session/update` is the primary session mirror path.

The normative implementation contract, migrations, APIs, provider adapters, rollout order, and acceptance gates are defined in [Local Native Agent and Workspace Replica Implementation Plan](./local-native-agent-implementation-plan.md). Where this architecture document is less specific, the implementation plan governs.

## Decision Summary

CoHub should support local and cloud execution through **workspace replicas**, not a remote filesystem mount.

A Space may have:

- a cloud workspace replica on the shared PVC;
- one or more explicitly authorized local workspace replicas;
- one active workspace writer at a time during the initial rollout.

`workspace_replicas` is separate from `space_sandboxes`: a cloud Space keeps its existing cloud sandbox record, while local replicas are synchronized filesystem copies. Legacy local-sandbox Spaces are not implicitly converted.

Native agents run in the environment where they are installed:

```text
local Pi/Codex/Claude -> local workspace replica
cloud CoHub Agent     -> cloud workspace replica (/workspace)
```

A sync daemon keeps replicas convergent. Agent tools are not intercepted or replaced. The local provider keeps its own credentials, plugins, and native session. CoHub keeps its existing JSONL transcript and DB projection separately. Workspace replication and native-session mirroring require separate explicit consent; attaching a folder does not automatically upload conversation content.

Web remains the primary surface and defaults to the cloud executor. A local executor is an optional workspace writer that must synchronize before and after a turn handoff.

## Why Replicas, Not Mounts

A FUSE or rclone mount would make remote files look local, but would not provide the remote execution environment:

- local `bash`, `git`, package managers, and provider plugins would still run locally;
- editor rename/fsync/file-lock semantics would be difficult over the current high-level sandbox RPC;
- latency and offline behavior would be poor;
- a mount does not solve bidirectional conflict handling.

The desired behavior is two real copies with explicit synchronization:

```text
local files <-> sync protocol <-> cloud files
```

The local Agent can then use the real local environment, and the cloud Agent can use the real cloud sandbox environment.

## Existing CoHub Facts

Current code already provides useful pieces:

- `cohub sandbox up <dir>` runs `sandboxd --local --root <dir>` and exposes a local directory to a Local Space.
- Existing Spaces passed to `sandbox up --space` must already use `provider: local`.
- Cloud sandbox workspaces are mounted from the shared PVC at a path equivalent to `/space-storage/{spaceId}/workspace`.
- Local sandbox events are relayed through Gateway, but `fs.changed` is a notification, not a replication protocol.
- Sandbox RPC currently exposes high-level `fs.read`, `fs.write`, `fs.edit`, `fs.mkdir`, `fs.stat`, `fs.ls`, `fs.tree`, `fs.find`, `fs.grep`, `process.start`, and `process.abort`.
- Checkpoint code already scans files, hashes content, filters unsafe paths, materializes snapshots, and stores large assets separately.
- Session JSONL and `session_messages` are execution/product state and must not become the workspace file transport.

Relevant existing modules:

- `apps/worker/src/checkpoint/scan.ts`
- `apps/worker/src/checkpoint/materialize.ts`
- `apps/worker/src/checkpoint/repo-sync.ts`
- `apps/sandbox/filewatch/`
- `apps/gateway/src/relay/`
- `apps/api/src/space-fs-remote.ts`
- `apps/api/src/space-sandboxes.ts`
- `apps/agent/src/runtime/paths.ts`

## Domain Model

### Space

The logical project, permissions, sessions, and timeline container.

### Workspace Replica

One physical copy of a Space workspace.

```ts
type WorkspaceReplicaKind = "cloud" | "local";
type WorkspaceReplicaStatus =
  | "attaching"
  | "ready"
  | "syncing"
  | "conflicted"
  | "offline"
  | "error"
  | "detached";

// `in_sync`, `local_ahead`, and `cloud_ahead` are derived UI labels from
// canonical/applied/current snapshot IDs; they are not persisted statuses.
```

A local replica has a private absolute root path that is never sent to or displayed by the server. The server stores only a user-visible label, device identity, and capabilities.

### Workspace Snapshot

An immutable manifest plus content references representing one replica state. Snapshot lifecycle (`uploading`, `uploaded`, `verifying`, `ready`, `rejected`) is separate from the canonical and applied pointers held by workspace state/replica rows.

```ts
type WorkspaceSnapshot = {
  id: string;
  spaceId: string;
  sourceReplicaId: string;
  replicaGeneration: number;
  parentSnapshotId: string | null;
  baseCanonicalSnapshotId: string | null;
  manifestObjectKey: string;
  manifestSha256: string;
  treeHash: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
};
```

### Workspace Sync Session

The stateful relationship between a local replica and the cloud replica. It retains the last common snapshot used as the base for three-way reconciliation.

### Workspace Writer Lease

A short-lived logical lease saying which executor may modify the workspace. This is separate from the existing session lock.

```text
workspace writer: local | cloud | none
```

Initial rollout is single-writer. True concurrent editing can be added later without changing the provider integration model.

## Target Architecture

```text
                    CoHub Cloud

  API / Web / Mobile
          |
          +-- workspace sync coordinator
          +-- cloud workspace replica (/space-storage/.../workspace)
          +-- snapshot manifest and blob storage
          +-- CoHub session JSONL + Postgres projections
          +-- cloud Agent
                         |
                         v
                    cloud sandbox

          ^
          | authenticated control + HTTPS/blob transfer
          |
  cohub-locald / local Agent connector
          |
          +-- local workspace replica
          +-- native Pi/Codex/Claude process
          +-- native provider session/config/credentials
```

`cohub-locald` is a replica and hook-ingest daemon; it does not register as the Space sandbox. Control and notifications use a narrow authenticated stream with polling fallback. Large file contents use authenticated HTTPS/object-storage transfers, not long-lived WebSocket frames.

## Replica Storage

### Cloud Replica

The cloud replica remains the current Space workspace on the shared PVC. Existing cloud Agent and sandbox behavior remains unchanged.

### Local Replica

The local daemon stores its SQLite state, durable event/turn/manifest spool, and apply journals in the platform-appropriate CoHub user data directory. State is outside the project root, except for the excluded `.cohub/system/sync` staging area used for crash-safe apply. The server also stores explicit per-device/Space session-mirror consent; workspace attachment alone does not upload native session content.

The absolute root is local-only. The server receives a root fingerprint and display label, never the path.

## Manifest

Paths are always POSIX-relative to `/workspace`:

- no leading slash;
- no `..` components;
- no backslashes or NULs;
- UTF-8 byte ordering after NFC normalization;
- reject names that change under required normalization, Windows reserved names, trailing dot/space names, unsupported control characters, or target platform path-length limits;
- case-collision detection on case-insensitive filesystems.

Each entry contains:

```ts
type WorkspaceManifestEntry =
  | { path: string; type: "directory" }
  | {
      path: string;
      type: "file";
      size: number;
      sha256: string;
      executable: boolean;
    }
  | { path: string; type: "symlink"; symlinkTarget: string };
```

V1 uses one whole-file content-addressed blob per regular file. Large files use resumable multipart transfer but retain the same whole-file hash identity; chunk dedupe is deferred to a future manifest version.

Rules:

- Hashes, not mtimes, are the correctness identity.
- mtime and size are scan accelerators only.
- Symlinks must be relative and stay inside the replica root.
- Sockets, FIFOs, devices, and unsafe symlinks are excluded and reported.
- `.git/` and `.cohub/system/` are hard exclusions; directory entries are included so empty directories survive replication.
- Managed-path scan/read errors produce an incomplete candidate and never become an empty/deletion snapshot.
- Dependency caches and common build output follow the accepted Space scan policy. `.cohubignore` is a managed proposal file: edits do not change scanner behavior until an owner/admin confirms the policy transition, and server safety exclusions cannot be removed. Likely credential files are excluded by the default sensitive-content policy with a visible warning; explicit Space owner/admin policy consent is required to include them, and devices cannot override the canonical managed set in v1.
- Provider credentials and provider home directories are outside the attached root. Project files selected by the sensitive-content policy are either explicitly excluded and left unmanaged or explicitly included with consent; they are never silently dropped from a supposedly complete replica.
- Files over configured limits are transferred through resumable multipart object storage or rejected with an actionable status.

The existing checkpoint scanner is a good starting point, but its path/hash primitives should be extracted into a shared policy-driven module rather than importing worker-only code into the local daemon. Replication scans must fail closed: managed-path I/O/hash errors produce an incomplete candidate, not an empty tree. Use bounded workers, stable-before/after hashing, watcher-overflow full scans, and separate checkpoint `.gitignore` versus accepted Space replication `.cohubignore` policies.

## Content Transfer

Use content-addressed blobs:

```text
workspace-sync/{environment}/spaces/{spaceId}/blobs/{sha256}
```

A manifest references blobs by hash. The server never trusts a client-provided hash without verifying the uploaded bytes.

Transfer behavior in v1:

- all files have one content-addressed whole-file SHA-256 blob identity;
- small files: whole-file upload/download;
- large files: resumable S3 multipart upload/download, verified by the final whole-file hash;
- chunk-level dedupe and rsync-style rolling deltas are deferred to a future manifest version;
- content is written to a staging area and verified before it is applied;
- apply uses temp file + fsync + atomic rename where the platform supports it;
- executable bit and safe symlink target are preserved;
- partial transfers remain resumable but are never visible as workspace files.

The existing turn-object S3 path is not the right namespace for workspace blobs. Workspace sync needs its own object-key policy and retention rules.

## Three-Way Reconciliation

Every sync cycle compares:

```text
B = last common snapshot
L = local manifest
C = cloud manifest
```

For each path:

| Base      | Local       | Cloud               | Result              |
| --------- | ----------- | ------------------- | ------------------- |
| unchanged | unchanged   | unchanged           | no-op               |
| unchanged | changed     | unchanged           | copy local -> cloud |
| unchanged | unchanged   | changed             | copy cloud -> local |
| unchanged | same change | same change         | converge            |
| unchanged | changed     | changed differently | conflict            |
| exists    | deleted     | changed             | conflict            |
| exists    | changed     | deleted             | conflict            |
| missing   | created     | created differently | conflict            |

Rename detection is optional in the first version. A delete + create is safer than incorrectly joining two unrelated files.

### Conflict Policy

Default mode is `two-way-safe`:

- never silently discard unsynchronized data;
- allow deterministic diff3 auto-merge only for bounded UTF-8 text when it reports a clean merge; otherwise do not resolve modify/modify automatically;
- do not resolve delete/modify conflicts automatically;
- keep both content versions in conflict storage;
- mark the sync cycle and Space replica `conflict`;
- block execution handoff until the conflict is resolved or explicitly discarded.

Conflict records should contain:

```ts
type WorkspaceConflict = {
  id: string;
  spaceId: string;
  cycleId: string;
  path: string;
  baseSha256: string | null;
  localSha256: string | null;
  cloudSha256: string | null;
  kind:
    | "content"
    | "delete_modify"
    | "type"
    | "case_collision"
    | "path_normalization"
    | "path_unsupported"
    | "git_ref"
    | "scan_policy";
  status: "open" | "resolved" | "discarded";
  resolution?:
    | "local"
    | "cloud"
    | "merged"
    | "deleted"
    | "keep_managed"
    | "unmanage";
};
```

Do not immediately create random `.sync-conflict-*` files inside the project. They pollute the Agent workspace. Store conflict versions outside the workspace and expose them through the CoHub UI/CLI. An optional export command can materialize them for manual inspection.

## Sync Modes

### `two-way-safe`

Background replica mode. Both replicas may change while disconnected. Non-conflicting changes merge; conflicting changes block. It is not permission for two Agents to execute concurrently.

This follows the useful part of Mutagen's `two-way-safe` and Unison's three-way model.

### `one-way-to-cloud`

Local changes are published to cloud. Cloud changes are never applied locally. Useful for a local working copy feeding Web.

### `one-way-to-local`

Cloud is authoritative and local is a checkout. Local modifications are rejected or quarantined.

### `handoff`

The execution-oriented mode. Before an Agent turn starts, the selected replica must be synchronized and acquire the workspace writer lease. This is the initial default for Agent execution even if background two-way sync is enabled. The explicit `cohub workspace handoff local --wait` command prepares the local permit; provider-specific preflight interception is enabled only when its versioned adapter proves that capability.

## Execution Handoff

File synchronization and Agent execution must be coordinated, but they are separate modules.

### Local Turn

```text
1. Ensure the local replica is at the canonical snapshot.
2. Stop on conflict; do not start the Agent in strict online mode.
3. Acquire the fenced workspace writer lease with the canonical snapshot as base.
4. Start native Pi/Codex/Claude against the local root.
5. Watch local changes; hooks spool provider events through local IPC.
6. On completion or interrupt, seal a workspace candidate and native turn bundle.
7. Upload workspace and session bundles independently with durable ACKs, carrying the same execution attempt ID.
8. Reconcile/apply the workspace and commit CoHub JSONL + DB through their separate workers; background remote apply never writes into the active local cwd.
9. Make cloud execution eligible only after the cloud replica applies the canonical result and the transcript visibility barrier is complete.
10. Release the writer lease after the result candidate is durably committed, or let it expire on failure.
```

### Cloud Turn

```text
1. Ensure cloud replica is current and allocate an execution attempt.
2. If local writer is active, wait or require explicit stop/handoff.
3. Acquire workspace writer lease = cloud.
4. Run the existing cloud Agent against cloud /workspace with the attempt context.
5. Save and verify the resulting cloud snapshot and CoHub transcript.
6. If a local replica is online, queue propagation while its own execution attempt is active, otherwise apply and verify the cloud delta.
7. Mark the execution attempt complete only after both workspace and transcript barriers pass, then release workspace writer lease.
```

The first implementation must not allow local and cloud Agents to modify the same logical workspace concurrently. Background watcher scans are allowed, but canonical promotion/apply is gated by the active execution attempt and writer epoch. CoHub-mediated cloud mutations carry the attempt capability; registered process groups are stopped before takeover. Arbitrary processes outside CoHub remain unfenced and force stable rescan/reconciliation. A future concurrent mode can use the same three-way engine, but it needs stronger conflict UX and tool semantics.

### Offline Behavior

A local Agent may continue while temporarily offline because it owns a real local replica. The user first enables an intentional offline reservation when connected; that reservation blocks cloud Agent/file execution for its configured maximum duration. Without a reservation, an offline local process has no ownership claim.

When offline:

- local work remains in the local spool/state;
- Web can view the last cloud snapshot;
- cloud execution may continue only if its own replica is current and no unexpired local reservation/known local writer is active; an unknown offline local process is handled by stale-base reconciliation, not assumed idle;
- reconnect performs three-way reconciliation;
- conflicts block automatic handoff.

## Session and Turn Integration

Workspace sync does not replace native provider sessions.

```text
Native provider state:
  local ~/.pi, ~/.codex, ~/.claude, provider plugins and credentials

CoHub state:
  session JSONL, session_messages, session_turns, realtime
```

At a local turn boundary, the local provider connector locally sanitizes and exports a normalized transcript delta. The server writes the existing CoHub JSONL and DB projection using the same logical message ordering as the cloud Pi path. Raw native transcript bytes are never uploaded. An execution-attempt barrier joins the workspace result and transcript result; either can finish first, but cloud continuation waits for both required barriers.

### Session Is Not Workspace Sync

Do not run generic bidirectional file synchronization over `/sessions` or provider-native session directories. A workspace is a set of independently mutable paths; a session is an ordered transcript tree with turn lifecycle, parent links, compaction, forks, and provider-specific message semantics. Treating session JSONL as an ordinary file replica would create conflicts that the workspace merge engine cannot interpret.

Session mirroring uses a **server-owned transcript protocol**:

```text
local native session -> local connector -> CoHub transcript delta
                                             |
                                             +-- CoHub JSONL
                                             +-- session_messages/session_turns
                                             +-- realtime events
```

The local provider never receives database credentials and never writes the cloud session file directly. Its native transcript remains a local shadow used for same-provider resume. The server-side CoHub JSONL remains the transcript consumed by the cloud Agent.

### Transcript Cursor

Every execution starts from a transcript cursor. The cursor is not a provider session ID:

```ts
type CohubTranscriptCursor = {
  version: 1;
  sessionId: string;
  branchEpoch: string;
  leafEntryId: string | null;
  leafHash: string;
  entryCount: number;
  lastTurnSequence: number;
};
```

`leafHash` is a hash-chain digest of the server-owned visible branch. `branchEpoch` changes on fork, rewind, or compaction rewrite. The cursor can be derived from the existing v3 JSONL and cached in run metadata and a sidecar index; this does not require a JSONL format migration.

A local run carries its execution attempt, workspace snapshot, and transcript cursor. If the CoHub head still matches, the native delta can append. If Web/cloud advanced the CoHub branch, the server creates a child session at the binding's last common completed turn and appends the native continuation there. A stale cursor must never be appended silently to the advanced parent.

The workspace handoff carries an execution attempt plus both state coordinates:

```ts
type ExecutionBase = {
  executionAttemptId: string;
  workspaceSnapshotId: string;
  transcriptCursor: CohubTranscriptCursor;
};
```

A workspace can be current while the conversation is stale, and a conversation can be current while the files are stale. Both must match before an Agent starts.

### Native Local Agent Is Not a CoHub Runtime

A local Agent is deliberately treated as a native application running in a local workspace. CoHub does not inject its system prompt, tool definitions, model configuration, or hidden context into the local provider.

```text
local Pi/Codex/Claude
  -> local replica root
  -> local provider config, skills, plugins, credentials, tools

CoHub
  -> workspace synchronization
  -> session correlation and transcript export
  -> product projection and Web/cloud continuation
```

The local provider's own prompt and native session are authoritative for the local turn. This is what preserves the real local environment and avoids pretending that CoHub can safely replace every provider's tool system.

The local daemon, not the provider, owns correlation metadata:

```ts
type LocalAgentBinding = {
  spaceId: string;
  sessionId: string | null;
  replicaId: string;
  runtime: "pi" | "codex" | "claude_code" | string;
  executionAttemptId: string | null;
  workspaceSnapshotId: string | null;
  transcriptCursor: CohubTranscriptCursor | null;
  workspacePolicyVersion: number;
  integrationPolicyVersion: number;
  nativeSessionKey: string; // Space/replica-scoped device HMAC
};
```

The provider hook only writes lifecycle input to owner-only local IPC. `cohub-locald` maps `cwd` to a replica, replaces raw provider IDs with Space/replica-scoped device HMAC values, and authenticates network requests with a device credential unavailable to the hook process. A local-only collision fingerprint prevents one native session from being attached to two Spaces without creating a cross-Space server identifier.

### Hook and Export Model

Provider hooks are an observation and export seam, not a universal tool protocol:

```text
native provider lifecycle
  -> provider hook / extension / SDK callback
  -> local cohub sync daemon
  -> durable local spool
  -> authenticated CoHub session-sync endpoint
```

The connector normalizes only the facts the provider exposes. It must not assume that all providers expose identical tool or token events.

The common uploaded hook envelope is intentionally small. It carries a UUIDv7 event ID, provider and adapter versions, replica identity, HMAC native session/turn keys, an optional provider event sequence plus a daemon-local receipt sequence, relative cwd, workspace execution base, lifecycle type, timestamp, and validated provider payload. Arrival order is diagnostic only when a provider does not expose causal ordering. Raw provider session IDs, transcript paths, absolute cwd, and device credentials are not uploaded.

The reliable synchronization point is `turn_stopped`/`turn_failed`, not a token hook. At that point the connector reads the provider's native history since the last exported native cursor and sends a logical transcript delta. Provider-specific adapters may add tool lifecycle events for live UI, but a missing live hook must not prevent a complete turn export.

The hook command must be fast and non-blocking by default. It writes to the local spool and returns; a long network request must not hold up the user's native Agent. A local sync daemon performs retries, compression, upload, and ACK handling.

### Session Mirror Is Directional

The v1 production contract standardizes only local-to-CoHub import. Session content consent is independent of workspace attach: `full` imports portable content, `metadata_only` stores no product session/turn/JSONL content and cannot continue in cloud, and `disabled` installs/accepts no session mirroring hooks or content.

```text
local native history/events -> CoHub transcript delta -> server JSONL + DB
```

Cloud/Web turns are not imported into an existing native session. If that older native session continues, its new turn is mirrored into a CoHub fork at the last common completed turn. This preserves both branches without rewriting provider history or injecting CoHub context. The transcript fork does not automatically fork workspace state: its workspace candidate is reconciled against current Space canonical, promoted only when conflict-free, and otherwise retained as an explicit workspace conflict.

A future explicit export command may create a new provider-native session when an official provider API can do so safely. It is not implicit session synchronization and is outside v1.

### Transcript Delta

The first protocol version should synchronize at logical message boundaries, not every token:

```ts
type CohubTranscriptDelta = {
  runId: string;
  sessionId: string;
  turnId: string;
  base: CohubTranscriptCursor;
  events: CohubTranscriptEvent[];
  workspaceSnapshotId: string;
};

type CohubTranscriptEvent =
  | { kind: "user_message"; eventId: string; message: unknown }
  | { kind: "assistant_round"; eventId: string; message: unknown }
  | { kind: "tool_result"; eventId: string; message: unknown }
  | { kind: "compaction"; eventId: string; entry: unknown }
  | {
      kind: "turn_terminal";
      eventId: string;
      status: "completed" | "interrupted" | "failed";
      error?: string;
    };
```

This is a conceptual projection shape only. The uploaded v1 bundle is sanitized locally, uses HMAC native identities, and is committed through `native_agent_turns`/`native_agent_ingests`; it is not a raw provider transcript or a public SDK schema.

For the current cloud Pi runtime, the `message` payload must be a valid Pi-compatible `AgentMessage`:

- `user` messages;
- `assistant` messages containing `toolCall` blocks when applicable;
- separate `toolResult` messages;
- final assistant messages;
- explicit compaction/custom entries where the provider exposes them.

CoHub `ContentBlock` values are the DB/realtime projection, not a replacement for the Pi transcript shape. Provider provenance belongs in metadata, but provider session/message/tool identifiers are uploaded only as Space/replica-scoped device HMAC keys such as `nativeSessionKey`, `nativeMessageKey`, and `nativeToolCallKey`.

The three identity layers must stay separate:

```text
eventId       transport retry identity
messageKey    logical message/round identity
entryId       server-assigned CoHub JSONL entry identity
```

### Server Commit and ACK

A single server-side transcript committer owns the write sequence. It should be extracted from the current Agent event and persistence paths before local Agent support is added.

```text
1. validate device/replica, binding, native turn, base cursor, consent policy, and workspace provenance
2. acquire the fenced CoHub session writer lease
3. append native JSONL entries with a hidden ingest identity and fsync the batch
4. project the same logical messages into session_messages/session_turns
5. write stable realtime envelopes to the durable outbox in the projection transaction
6. append/fsync the deterministic transcript visibility marker and update the cursor/index
7. ACK the durable ingest; dispatch realtime outbox rows independently
```

The local connector retains its spool until semantic ingest ACK. Retries use `bundleId` plus `eventId`/native identity idempotency. A JSONL append that succeeds before a DB failure is repaired by replaying the DB projection; a DB projection is not considered durable success until the corresponding JSONL entry exists. Realtime envelopes use a durable outbox and stable IDs because Redis publish is not transactional with Postgres.

The committer must serialize against the existing session lock. It must not be implemented as a second ad hoc copy of `SessionManager` and `persistence.ts`.

### Turn Lifecycle

```text
local prompt submitted
  -> hook spools locally without a network dependency
  -> daemon records the applied workspace snapshot and observed transcript cursor
  -> server creates the native_agent CoHub turn when connectivity permits
  -> local provider runs against the local replica
  -> local connector seals native events/history at the turn boundary
  -> transcript and workspace bundles commit through independent durable ingests
  -> mirrored turn becomes terminal when transcript projection commits
  -> cloud execution remains gated until the result snapshot is canonical and applied
```

The workspace and transcript commits are related but not one filesystem transaction:

- if transcript commit fails, retain the local spool and do not hand the workspace to the cloud Agent;
- if workspace sync finds a conflict, keep the transcript visible but block the next executor until the conflict is resolved;
- if the local provider is interrupted, commit the partial assistant/tool state and mark the turn `interrupted`;
- if a tool result is unknown, do not replay the tool automatically.

Cloud Web turns keep the existing CoHub transcript path. The workspace coordinator captures their cloud result snapshot and propagates only the workspace delta to local replicas; it does not propagate cloud transcript bytes into native sessions.

### Live and Boundary Modes

Session mirroring should ship in two temporal modes:

`turn_boundary` is the MVP:

- local Agent runs natively;
- Web sees a local-running status;
- completed/interrupted logical messages arrive after the turn commit;
- no token-level local stream is required.

`live_projection` is the follow-up:

- local deltas are forwarded through the existing `session.turn.patch` protocol;
- token/thinking deltas stay realtime-only;
- assistant rounds and tool results are persisted at logical boundaries;
- reconnect uses the transcript cursor and event ACK, not timestamps.

This keeps the Web path unchanged. The existing Web client can continue consuming `session.turn.patch`, `session.message.persisted`, and `session.turn.finalized`. Workspace status is an additive `workspace` realtime domain; it carries generations/conflicts/attempt IDs, never file bytes.

### Native Session Rules

Provider-native state is never treated as a cross-provider synchronization format:

```text
~/.pi, ~/.codex, ~/.claude, provider plugins, and credentials
  remain on the executor that owns them

CoHub JSONL and DB
  contain the server-owned CoHub transcript and product projection
```

Same-provider native resume is local provider behavior. Cloud continuation uses the CoHub transcript and synchronized cloud workspace. A provider switch starts or uses a separate native session; CoHub does not rewrite Claude or Codex session files into Pi's format.

Compaction and fork are server-owned CoHub transcript operations. After cloud/Web advances the CoHub transcript, the existing native session remains at its own native head. Its later continuation creates a CoHub fork; it is never appended to the advanced parent or silently rewritten.

Hooks are not guaranteed to fire on provider crashes or forced termination. The default workflow does not supervise the native provider process. `provider_exited` exists only for an explicit supervised launch mode; otherwise SessionEnd/shutdown hooks, stale-turn recovery, and later versioned history reconciliation close or recover incomplete turns.

### Session Mirror Control Operations

The daemon uses authenticated prepare/commit/status operations for immutable native turn bundles. Hooks use local IPC only. There is no v1 context-get, remote native interrupt, or native history import operation.

Small control notifications use a narrow authenticated API event stream with generation polling fallback. Large turn deltas and tool outputs use compressed HTTPS/object-storage transfer with size limits. Gateway sandbox RPC is not the session transport.

### Session MVP Rollout

1. Extract a `CohubTranscriptReader` and `CohubTranscriptCommitter` around the existing `SessionManager` and persistence code.
2. Define the hook envelope, local spool, transcript cursor, and turn-boundary commit protocol.
3. Implement a local Pi hook/extension that exports completed and interrupted turns; do not inject CoHub prompts or tools.
4. Add cloud continuation from the committed CoHub JSONL.
5. Add stale-turn recovery and optional live projection; process-exit events are available only in an explicit supervised mode.
6. Add Claude and Codex hook/history connectors one at a time.

The first local connector should not try to make a local native session file identical to the cloud file. It should observe the native session and export the logical delta required to advance the server-owned CoHub transcript.

The turn metadata should record the workspace snapshot used by the execution:

```json
{
  "workspaceSync": {
    "replicaId": "...",
    "baseSnapshotId": "...",
    "committedSnapshotId": "...",
    "handoffMode": "two-way-safe"
  },
  "runtime": {
    "executor": "local",
    "provider": "codex",
    "nativeSessionKey": "space-replica-scoped-hmac"
  }
}
```

These fields can initially live in existing JSONB metadata. A later schema migration can promote them to indexed columns if querying requires it.

The local native session is not uploaded as the authoritative CoHub session. It is retained locally for same-provider resume. Web/cloud continuation uses the CoHub transcript and the synchronized cloud workspace; it is a portable continuation, not an attempt to recreate hidden provider state.

## Local Agent and Sandbox Relationship

For a local replica:

```text
local Agent cwd       = local replica root
cohub-locald root     = same local replica root
native provider tools = direct local filesystem/process access
```

The native Agent does not route tools through CoHub RPC. `cohub-locald` observes files and provider hooks, but it is not registered as the Space sandbox. CoHub Web and cloud services continue to use the cloud sandbox and see local changes after replication.

For a cloud replica:

```text
cloud Agent cwd = /workspace in cloud sandbox
```

A local native Agent must not be advertised as operating in the cloud replica. File replication is the bridge between environments; it is not a remote process environment.

## Control Protocol

Control plane requests use authenticated HTTPS. A narrow API event stream provides low-latency generation notifications, with ETag polling as the correctness fallback. Large contents use signed blob transfer.

The v1 control contract is exposed as authenticated HTTPS endpoints:

```text
POST /v1/local-devices/enroll
POST /v1/spaces/:spaceId/workspace-replicas
GET  /v1/workspace-replicas/:replicaId/events?after=<generation>
POST /v1/workspace-replicas/:replicaId/snapshots/prepare
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/commit
GET  /v1/workspace-replicas/:replicaId/sync-plan
POST /v1/workspace-replicas/:replicaId/sync-plans/:cycleId/applied
POST /v1/workspace-replicas/:replicaId/sync-plans/:cycleId/failed
POST /v1/spaces/:spaceId/workspace-lease/acquire
POST /v1/spaces/:spaceId/workspace-lease/renew
POST /v1/spaces/:spaceId/workspace-lease/release
```

Prepare carries manifest/blob descriptors and canonical checksums, not the full manifest over the request path. Large structured payloads are uploaded to short-lived signed object URLs. Commit records an immutable `uploaded` row after object metadata verification; the worker advances it to `ready` only after decompression, schema, hash, and referenced-blob checks.

A sync plan is a durable `workspace_sync_cycle` identified by `cycleId`. Its compressed plan object contains declarative, idempotent operations, precondition hashes, conflict records, and delete-safety stats. Every apply includes the expected base snapshot and lease epoch. A stale base or precondition receives a new plan; it is never applied blindly.

## Durable Metadata

The implementation plan defines additive durable tables for devices, replicas, canonical workspace state, immutable snapshots, sync cycles, conflicts, writer leases, native bindings/turns/ingests, and the realtime outbox. This document intentionally keeps only the conceptual names; the implementation plan is the migration source of truth.

Postgres is authoritative for lease epochs, replica/snapshot/conflict state, ingest state, and canonical generations. Redis may accelerate mutex contention, progress, heartbeat, queueing, and notification fanout, but losing Redis cannot lose accepted state or ownership evidence. Object storage holds immutable manifests, blobs, plans, sanitized native bundles, and retained conflict versions.

## Security and Data Safety

### Authentication

A device receives a short-lived access token scoped to the authenticated device/user. Each request is additionally bound server-side to:

```text
userId
spaceId
replicaId
deviceId
permissions
expiry
protocolVersion
```

Provider hooks receive no token. They write to owner-only local IPC; only `cohub-locald` uses device authentication.

Do not give the local daemon:

- `DATABASE_URL`;
- worker secret;
- unrestricted S3 credentials;
- another user's workspace access.

### Path Safety

Apply the same rules as the current checkpoint scanner and local sandbox:

- reject absolute paths and traversal;
- reject unsafe symlinks;
- resolve and validate local root before registration;
- detect case-folding collisions;
- never follow paths outside the selected root.

### Excludes

Hard exclusions are limited to data that is unsafe to replicate as workspace content:

```text
.git/
.cohub/system/
sockets, FIFOs, devices, and unsafe symlinks
provider homes and credentials outside the attached root
```

Dependency caches and common build outputs follow the accepted Space scan policy compiled from platform defaults and the confirmed `.cohubignore`. Likely credential files such as `.env*`, private keys, credential/config filenames, and provider token stores inside the root are excluded with a visible warning by default; a Space owner/admin may explicitly enable `include_with_consent`. The effective Space policy/version is visible and hashed into every manifest. CoHub must not silently omit an otherwise included project file; excluded bytes remain local/unmanaged and are never deleted by sync.

### Safe Deletes

Borrow rclone's safety ideas:

- dry-run plan before first sync;
- maximum delete threshold;
- abort on listing/scan errors;
- retain deleted content in a short-lived trash/quarantine area;
- require explicit confirmation for mass deletion;
- never make an incomplete scan look like an empty workspace.

## Open Source References and What to Borrow

### rclone

[rclone bisync](https://rclone.org/bisync/) is useful for:

- retaining previous listings;
- detecting new/changed/deleted entries on both sides;
- explicit resync/recovery;
- lock files and delete safety limits;
- conflict options.

[rclone mount](https://rclone.org/commands/rclone_mount/) is useful as a warning: a VFS mount has caching and filesystem-semantic limitations and does not solve remote process execution.

CoHub should borrow the safety model, not embed rclone as the primary engine. CoHub needs Space-scoped authorization, provider-independent snapshots, conflict UI, and integration with cloud PVCs.

### Mutagen

[Mutagen synchronization](https://mutagen.io/documentation/synchronization/) is the closest algorithmic reference:

- local and remote endpoints are equal replicas rather than source/destination;
- filesystem watching triggers short sync cycles;
- a three-way merge uses the last agreed state;
- differential transfers reduce latency and bandwidth;
- `two-way-safe` avoids destructive automatic conflict resolution.

CoHub should use Mutagen's conceptual model, but v1 uses the CoHub manifest/reconcile engine and `cohub-locald`; embedding Mutagen would still require a second endpoint, auth, snapshot, and lifecycle layer.

### Unison

[Unison](https://github.com/bcpierce00/unison) demonstrates:

- user-level synchronization without a filesystem mount;
- two replicas that can work offline;
- three-way reconciliation;
- explicit conflict detection;
- resilience across abnormal termination.

These properties match CoHub's data-safety requirements.

### Syncthing

[Syncthing's synchronization model](https://docs.syncthing.net/users/syncing.html) is useful for:

- block-oriented transfer;
- persistent peer synchronization;
- conflict copies and versioning;
- watcher plus periodic scan behavior.

CoHub additionally needs a cloud coordinator and explicit execution leases, which Syncthing does not provide.

### Recommended Technology Choice

Do not start by embedding rclone mount or implementing FUSE.

Recommended path:

1. Build a CoHub-specific manifest/three-way sync engine with Mutagen/Unison semantics.
2. Reuse rsync-style differential transfer ideas for large files.
3. Use content-addressed blobs and signed transfer URLs.
4. Keep the local daemon user-space and cross-platform.
5. Reuse the existing Go filesystem-watcher primitives in `cohub-locald` as an event hint, but scan independently for correctness.
6. Do not embed rclone, Mutagen, Unison, or Syncthing in v1; borrow their reconciliation, deletion-safety, and recovery semantics behind a CoHub-owned protocol.

## Module Layout

Suggested modules:

```text
packages/protocol/src/workspace-replication/
packages/protocol/src/local-agent/
packages/core/src/workspace-replication/
packages/infra/src/workspace-sync-queue/
packages/infra/src/native-agent-queue/

apps/api/src/workspace-replication/
apps/api/src/native-agent-ingest/
apps/worker/src/workspace-replication/
apps/agent/src/transcript/
apps/agent/src/native-ingest/

packages/cli/src/commands/workspace.ts
packages/cli/src/commands/agent-hooks.ts
apps/sandbox/cmd/locald/
apps/sandbox/locald/
```

The pure `reconcile.ts` module should be independently testable with two directory manifests and a base manifest. It should not import DB, Redis, provider, or sandbox modules.

## Rollout Plan

### Phase 0: Algorithm Prototype

- Implement manifest normalization and three-way reconciliation against two local temp directories.
- Add tests for create/modify/delete/rename-like changes, conflicts, case collisions, symlinks, incomplete scans, and mass deletes.
- Reuse checkpoint scan rules.
- No Agent integration.

### Phase 1: Explicit One-Shot Workspace Attach

```bash
cohub workspace attach --space <space-id> --dir ./project
cohub workspace sync --space <space-id> --dry-run
cohub workspace sync --space <space-id>
```

- cloud -> local initial materialization;
- local -> cloud explicit push;
- immutable snapshot and manifest;
- no background two-way watch yet;
- no concurrent Agent execution.

This validates transfer, excludes, authorization, and cloud PVC application.

### Phase 2: Background Two-Way Sync

- local watcher with debounce;
- server notification channel;
- incremental sync plans;
- conflict state and UI/CLI;
- reconnect and offline local state;
- safe delete thresholds;
- local replica heartbeat.

Agents remain blocked from simultaneous execution; sync runs while replicas are idle.

### Phase 3: Agent Handoff

- local Agent connector starts a turn against local root;
- workspace writer lease;
- pre-turn sync and post-turn sync;
- cloud Agent refuses/queues while local writer is active;
- turn metadata records snapshot IDs;
- local transcript imports into existing CoHub JSONL + DB path.

Web remains unchanged as the default cloud executor except for additive workspace status.

### Phase 4: Native Provider Connectors

Order:

1. Pi extension and exact active-branch history export;
2. Claude Code official lifecycle hooks plus versioned history reconciliation;
3. Codex official lifecycle hooks plus versioned optional history reconciliation;
4. ACP-compatible providers after the three native integrations are stable.

Each connector observes provider-owned native session handling. The sync engine remains provider-neutral.

### Phase 5: Advanced Operation

- concurrent writers with explicit conflict UX;
- large-file rolling deltas;
- partial sync/selective paths;
- local-only Space cloud mirror;
- remote execution mode;
- workspace snapshots tied to turn rewind/fork.

## Web and Mobile Impact

Web remains first and cloud-default:

```text
Web prompt -> API -> cloud Agent -> cloud replica
```

Initial Web changes can be limited to additive status:

```text
workspace sync status
local replica online/offline
conflict count
active writer
last synced snapshot
```

No new local Agent transport is required in the Web composer. Web continues to use existing session/turn/message and realtime contracts.

A cloud turn should not start when a local writer lease is active. The Web can show a concise state and offer synchronize/takeover actions in a later phase; it cannot stop an unwrapped local provider process.

## Observability

Every sync cycle should log/trace:

```text
spaceId
replicaId
syncId
baseSnapshotId
resultSnapshotId
filesScanned
filesChanged
bytesUploaded
bytesDownloaded
filesDeleted
conflicts
scanDurationMs
transferDurationMs
applyDurationMs
```

Metrics:

- sync success/failure rate;
- conflict rate by path category;
- bytes and files per cycle;
- time spent in `syncing`/`conflict`/`offline`;
- stale replica count;
- writer lease contention;
- apply rollback count;
- checksum mismatch count.

## Required Tests

### Pure Engine

- identical manifests are a no-op;
- one-sided create/modify/delete propagates;
- same content on both sides converges;
- modify/modify conflicts are preserved;
- delete/modify conflicts are preserved;
- unsafe symlinks are rejected;
- case-insensitive collisions are rejected;
- incomplete scan never schedules mass deletes;
- stale base snapshot causes replanning;
- interrupted apply rolls back or remains invisible.

### Transfer

- resumable chunk upload/download;
- checksum mismatch;
- retry after connection loss;
- duplicate blob upload is idempotent;
- signed URL expiry;
- delete threshold abort.

### CoHub Integration

- attach an existing cloud Space to an empty local directory;
- local changes sync to cloud sandbox;
- cloud changes sync to local directory;
- local offline changes reconcile after reconnect;
- conflict appears in API and CLI;
- local writer blocks cloud Agent;
- cloud writer blocks local Agent;
- completed local turn references the committed workspace snapshot;
- Web continues after local handoff using the synced cloud workspace;
- existing Local Space behavior remains unchanged; it is a separate legacy local-sandbox path and is not implicitly upgraded to a cloud replica.

### Failure Injection

- process killed during scan;
- process killed during upload;
- process killed during staged apply;
- Redis unavailable;
- object storage unavailable;
- cloud workspace unavailable;
- local machine sleep/resume;
- two sync controllers for one replica;
- provider process crashes while holding writer lease.

## Final Product Semantics

The user experience should be:

```bash
cohub workspace attach <space-id> --root ./repo
cohub workspace handoff local --wait
cohub agent hooks install codex
codex --cd ./repo
```

Then:

```text
local native Agent works in ./repo
cohub-locald keeps the Space replica updated
CoHub Web sees the same Space and mirrored turn
Web/cloud Agent runs after a synchronized handoff
workspace changes can move back to local before the next local turn
```

The durable source separation remains:

```text
CoHub DB      = product projection and query source
CoHub JSONL   = CoHub runtime transcript for cloud continuation
Native state  = provider-specific local/cloud execution state
Workspace     = replicated file state with explicit snapshots and conflicts
```

The central invariant is:

> An Agent may execute only against a workspace replica whose snapshot and writer lease are known to CoHub. No executor silently assumes that another replica is current.
