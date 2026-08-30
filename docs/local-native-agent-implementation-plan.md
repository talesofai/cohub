# Local Native Agent and Workspace Replica Implementation Plan

Status: implemented behind rollout flags; production integration validation pending

Related design: [Workspace Replication Design](./workspace-replication-design.md)

## 1. Decision Summary

CoHub will support a local native Agent through two deliberately separate systems:

1. **Workspace Replication** synchronizes a real local workspace replica with the real cloud sandbox workspace.
2. **Native Session Mirror** observes a provider-owned local session through official hooks or extensions and imports its logical turns into a server-owned CoHub session.

The systems share execution anchors, but they do not share storage formats:

```text
ExecutionBase = ExecutionAttemptId + WorkspaceSnapshotId + CohubTranscriptCursor
```

The following decisions are final for the first production implementation:

- Web and mobile always execute through the existing cloud `apps/agent` path.
- Pi, Codex, and Claude continue to run as native local applications with their own prompts, tools, plugins, credentials, model settings, and session files.
- CoHub does not inject its system prompt, tool definitions, hidden context, or model settings into a local provider.
- CoHub does not proxy or replace native provider tools.
- Local provider credentials and provider home directories are never replicated.
- Workspace files use bidirectional replica synchronization with a canonical server snapshot, content-addressed blobs, three-way reconciliation, and explicit conflicts.
- Provider session files are never synchronized byte-for-byte.
- Native session history is mirrored from local to CoHub through provider adapters. CoHub-to-native history import is not part of the initial contract.
- A Web continuation appends to the current CoHub session. If the old native session later continues from its older native head, CoHub creates a fork at the last common completed turn.
- A workspace has one coordinated writer at a time in the normal online path. Intentional offline execution requires an explicit reservation; unexpected offline changes have no ownership claim and reconcile later.
- The server owns CoHub JSONL v3, Postgres projections, and realtime publication. A local daemon never writes `/sessions`, Postgres, Redis, or an internal worker API directly.
- Hooks perform only local IPC and durable spooling. They do not wait for network or workspace transfer.
- Transport and realtime delivery are at least once. JSONL/DB logical application is exactly once through durable ingest rows, content hashes, native event identities, and deterministic transcript entry identities. Realtime uses stable envelope IDs and idempotent entity reducers.

## 1.1 Current Repository Baseline

The plan is grounded in the current repository rather than a greenfield runtime:

- `apps/agent` already owns the BullMQ turn worker, per-session lock, session JSONL, Postgres projection, turn-object storage, and realtime publication.
- `apps/worker/src/checkpoint/scan.ts`, `materialize.ts`, and `git-bundles.ts` provide scanner/hash/materialization/Git bundle primitives to extract.
- `apps/sandbox` already provides Go filesystem watching, safe path resolution, process groups, and local relay behavior, but its current `sandboxd --local` mode exposes a legacy `provider=local` Space and is not a cloud-replica protocol.
- `space_sandboxes` remains one sandbox record per Space/provider; new local replicas therefore use separate tables.
- The implementation now spans Protocol, Core, DB migrations, API/SDK/CLI, locald, Worker, Agent native ingest, Web status UI, deployment templates, and a checksummed cross-platform locald release workflow.
- Current repository gates pass for TypeScript builds/typechecks, API/Agent/Web/Protocol/Core/CLI/Infra tests, Go tests/vet, Agent runtime smoke, and Web production build. Real Postgres/S3/BullMQ/PVC migration and chaos validation remains a deployment gate and is not represented by unit typechecking.

## 2. Product Contract

### 2.1 Attach a cloud Space locally

The primary workflow is:

```bash
cohub workspace attach <space-id> --root /path/to/folder
cohub agent hooks install pi
cohub workspace status
```

`workspace attach` does all of the following:

1. Verifies that the Space uses a cloud sandbox. Existing legacy `provider=local` Spaces are rejected in v1 with an explicit migration message.
2. Presents separate consent for workspace replication and native session mirroring. Session choices are `full logical content`, `metadata only`, or `disabled`; the choice is stored per device/Space and can be revoked. Workspace replication does not imply session-content upload.
3. Registers this device and a local workspace replica.
4. Compares the local tree with the Space canonical tree.
5. Materializes the cloud tree into an empty local root, or requires an explicit initial reconciliation choice for a non-empty root.
6. Starts `cohub-locald` as a user service.
7. Enables provider hooks only at user scope when session mirroring consent is `full` or `metadata_only`. With mirroring `disabled`, attach installs no provider session hooks; workspace replication remains available.
8. It does not add provider hook files to the project.

Initial reconciliation is never destructive by default:

- Empty local root: pull canonical cloud state.
- Non-empty root with identical tree hash: attach directly.
- Non-empty divergent root: stop and require `--merge`, `--use-cloud`, or `--use-local`.
- `--use-cloud` and `--use-local` create a recoverable backup snapshot before applying changes.

### 2.2 Run a native local Agent

The user starts Pi, Codex, or Claude normally inside the attached folder. CoHub does not launch or wrap the provider in the default workflow.

`SessionStart` tells `cohub-locald` to prepare local execution asynchronously: refresh canonical state, apply pending cloud changes, and request a short-lived local execution permit backed by the workspace writer lease. The hook returns after local spooling and never waits for that network work.

At the first submitted prompt:

1. The provider hook sends a local IPC preflight request; locald maps `cwd` to the longest matching attached workspace root. Exact-root collisions are rejected. Nested roots are allowed only with an explicit boundary record: the outer scanner treats the inner root as an unmanaged boundary (records its path/capability, never its descendants), and the deepest match wins for provider events. This prevents one path from being replicated into two Spaces.
2. In strict online mode, it checks a locally cached, unexpired execution permit whose canonical generation still matches the local applied snapshot.
3. If the permit is valid, locald allocates and durably persists an `executionAttemptId`, records the workspace execution base, and returns success.
4. If the cloud is ahead, another writer is active, or readiness is still pending, the hook returns a provider-native blocking decision within 100 ms: `Workspace handoff is not ready. Wait for CoHub sync, then submit again.` No execution attempt is allocated for a blocked prompt.

The preflight hook does not perform or wait for network I/O. Users who need deterministic readiness before opening/submitting in a provider can run `cohub workspace handoff local --wait`. Offline-enabled replicas bypass the online permit, allocate an `executionAttemptId` locally, and record their last applied canonical snapshot as a stale-capable base. Providers without a tested preflight interception use the permit prepared by the CLI: their first observed `prompt_submitted` event consumes the pending permit and binds its `executionAttemptId`; if no pending permit exists, locald records the event as `unpermitted` and the resulting candidate cannot be promoted without reconciliation.

At the turn boundary:

1. Provider events and the reconciled provider history delta are sealed into a durable local turn bundle carrying the same `executionAttemptId` allocated at prompt preflight.
2. The local workspace is scanned and uploaded as a candidate snapshot carrying the same `executionAttemptId`.
3. The native turn bundle is uploaded independently carrying the same `executionAttemptId` and consent policy version.
4. The server binds both durable records to `workspace_execution_attempts`; it commits the CoHub transcript projection and reconciles the workspace independently, then resolves the attempt barrier.
5. Spool retention advances only after durable server ACKs: a workspace candidate can be removed locally after its manifest/blobs are verified and committed (including a durable conflict), while a native turn bundle remains until its ingest is `applied` or the user explicitly exports/discards a quarantined bundle.

Session mirroring and workspace transfer can complete in either order. A cloud execution is not eligible until its cloud workspace replica has applied the canonical result snapshot.

### 2.3 Continue from Web or mobile

A mirrored local turn appears through the existing session turn/message/realtime model. Web does not become a local runner client.

When the user sends the next prompt from Web:

- API allocates a `workspace_execution_attempts` row and records its ID in the queued cloud turn before BullMQ claim.
- The prompt is handled by the existing API, BullMQ, cloud `apps/agent`, and cloud sandbox path.
- The cloud Agent reads the server-owned CoHub JSONL transcript containing the imported local turns.
- The cloud Agent uses CoHub's normal system prompt, tools, model settings, credentials, and sandbox.
- `/workspace` remains the permission/sync root, while the latest validated local `relativeCwd` becomes the equivalent cloud execution cwd `/workspace/<relativeCwd>`.
- The cloud turn records its own workspace execution base and result snapshot against the same execution attempt. The attempt is not completed until the cloud workspace snapshot is verified/canonical and the CoHub transcript is durably visible.

No cloud prompt is inserted into the provider's native local session.

### 2.4 Resume the old native session after a Web continuation

The native binding remembers the last common CoHub turn, transcript cursor, and workspace execution base. The target CoHub session must belong to the same Space and be editable by the authenticated device user; native binding never bypasses existing session membership/visibility permissions.

If the bound CoHub session has not advanced, the next local turn appends normally.

If cloud or Web turns have advanced the CoHub session, and the advanced work is terminal (a running/queued cloud turn is handled by the session execution gate first), the ingest processor automatically:

1. Creates a child CoHub session using the existing `session_forks` and `session_turn_segments` model with a deterministic fork operation key.
2. Anchors the child at the last completed turn mirrored from that native session.
3. Provisions the child JSONL through the existing branch-file mechanism.
4. Commits the new native turn to the child.
5. Moves the native binding to the child session.
6. Publishes the normal fork/session realtime updates.

The parent keeps the Web continuation. The child keeps the native continuation. Neither history is overwritten or synthetically merged.

A transcript fork does not implicitly create a private workspace branch in v1. The native execution attempt's workspace candidate is reconciled against the current Space canonical snapshot: non-conflicting changes may become the new Space canonical result and are attributed to the child/native turn; conflicting changes remain in conflict storage and block promotion. A future session/workspace branch feature may pair these histories explicitly, but it is not assumed here.

### 2.5 Offline mode

Strict online mode is the default. Offline local execution requires an explicit per-replica setting:

```bash
cohub workspace offline enable --max-duration <duration>
```

Offline mode records the last applied canonical snapshot as the execution base and obtains a durable `local_offline_reservation` before disconnecting when connectivity permits. The reservation blocks cloud Agent/file execution for that Space until the local attempt is terminal, the user explicitly releases it, or its configured maximum duration expires. This preserves single-writer handoff semantics during an intentional offline session.

On reconnect:

- The session turn is imported, forking if the CoHub transcript advanced.
- The workspace is reconciled against the recorded base and current canonical snapshot.
- Non-overlapping changes merge.
- Conflicting paths block canonical promotion and cloud execution until resolved.

Unexpected network loss without an offline reservation does not create ownership: the normal lease may expire, and later local changes are unattributed stale candidates. Cloud takeover after a still-running offline reservation requires an explicit confirmation and records a takeover boundary; CoHub cannot stop the unwrapped native process. A stale local lease is never treated as ownership, and an offline candidate is never an unconditional overwrite. In online strict mode, a local provider is expected to use the tested preflight extension/hook where available; if a provider cannot block before execution, the user-facing contract requires `cohub workspace handoff local --wait`, and the daemon labels any later unpermitted changes as unattributed candidates.

## 3. System Architecture

```text
Native Pi / Codex / Claude
        |
        | official hook / Pi extension
        v
cohub-locald hook subcommand
        |
        | Unix socket / named pipe, local only
        v
cohub-locald daemon
  - provider event spool
  - workspace watcher/scanner
  - local apply journal
  - device credential
  - upload/retry/ACK
        |
        | HTTPS control + presigned object transfers
        v
apps/api
  - auth and membership
  - replica control API
  - ingest prepare/commit
  - durable DB rows
  - best-effort BullMQ enqueue
        |
        +-------------------------------+
        |                               |
        v                               v
workspace sync worker              apps/agent native ingest worker
  - scan/apply cloud PVC             - provider adapter
  - three-way reconcile              - JSONL v3 committer
  - canonical snapshots              - DB projection
  - conflicts and checkpoints        - realtime publication
        |                               |
        v                               v
cloud /workspace PVC               /sessions PVC + Postgres + Redis
```

### 3.1 `cohub-locald`

Add a second Go binary under the existing `apps/sandbox` Go module, built from `apps/sandbox/cmd/locald`. It reuses the existing filesystem watcher, path validation, relay primitives, and cross-platform release pipeline, but it does not register as a Space sandbox.

Locald implementation dependencies are explicit: pinned `modernc.org/sqlite` for pure-Go WAL/full-sync state, pinned `github.com/zalando/go-keyring` for cross-platform OS-keychain access, pinned `github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer` for Go RFC 8785/JCS, and pinned `json-canonicalize` in TypeScript. Their licenses/security are recorded in the existing NOTICE/dependency review. TypeScript and Go canonicalizers must pass the same fixture vectors before either can produce protocol hashes. Locald transfers with the standard library HTTP client and presigned URLs; it does not receive S3 credentials or add an object-storage SDK.

The binary has two modes:

```text
cohub-locald daemon ...
cohub-locald hook --provider <provider> --event <event>
```

The short-lived `hook` process reads provider JSON from stdin and writes one framed event to the daemon's local socket. If the daemon is unavailable, it atomically writes directly to the local emergency spool and exits successfully. It never performs network I/O.

The daemon owns:

- Attached-root discovery, overlap/boundary validation, exact-root collision rejection, and longest-root matching for nested replicas.
- UUID allocation/persistence for `executionAttemptId` after a local permit is valid and before a provider prompt is allowed to run.
- Versioned provider collectors that locally allowlist logical history fields, remove provider system/hidden/config data, redact paths, and HMAC native session, turn, message, and tool identifiers before upload.
- A per-device identity secret used for those HMAC identities. It is stable for the life of an enrolled device and stored in the OS keychain; access-token rotation does not rotate identity keys. Explicit device revoke/re-enroll intentionally starts new native bindings. HMAC inputs use domain-separated labels (`session`, `turn`, `message`, `tool`, `path`), include `identityKeyVersion`, and include Space/replica scope for uploaded values so the server cannot correlate native IDs across Spaces. A session key includes provider name, an HMAC provider-home namespace/fingerprint, and the raw provider session ID; this prevents equal IDs in different native stores from colliding without uploading the home path. locald keeps a separate local-only collision fingerprint to prevent one raw native session being attached to two Spaces.
- A SQLite state database in `~/.local/share/cohub/locald/state.db` (platform-appropriate equivalent on macOS and Windows).
- Append-only hook spool files.
- Workspace scan cache keyed by path, size, mtime, file identity, and last verified hash.
- Upload state and server ACK state.
- Crash-safe apply and rollback journals.
- A narrow authenticated control stream with generation polling fallback.

SQLite runs in WAL mode with `synchronous=FULL`. It is local daemon state only and never replaces the server DB or immutable spool files. On corruption, locald preserves the database for diagnosis, rebuilds transfer/cache state from spool plus server status, and performs a full workspace scan before allowing strict execution.

### 3.2 API

The API performs authentication, Space membership checks, input validation, signed object transfer setup, and durable ingest registration. It does not scan a filesystem or translate provider history.

An accepted upload is represented by a Postgres row before the client receives an upload ACK. API verifies signed object identity, transport checksum, and compressed size without decompressing large payloads in the request thread. A worker verifies decompression limits, canonical hash, schema, and referenced blobs before advancing to semantic `ready`/`committed`. BullMQ enqueue happens after the API transaction, and a periodic sweeper re-enqueues uploaded/committed unapplied rows, so Redis queue loss cannot lose accepted work.

### 3.3 Workspace sync worker

Run workspace synchronization in a dedicated `apps/worker` deployment profile with its own BullMQ queue and bounded I/O concurrency. The worker already has the Space storage PVC and can scan or safely apply directly to `<space-storage>/<spaceId>/workspace`.

It owns:

- Cloud replica scans.
- Three-way reconciliation.
- Canonical snapshot promotion.
- Staged cloud apply.
- Conflict creation and resolution application.
- Git bundle capture/fetch planning.
- Asynchronous turn-boundary checkpoint creation/retry.

It never writes session JSONL.

### 3.4 Native session ingest worker

Add native ingest jobs to `apps/agent`, because this service already owns the session JSONL PVC, session lock, DB projection, and session realtime path.

It owns:

- Provider adapter selection and version validation.
- Native event/history reconciliation.
- Automatic session creation and forking.
- CoHub JSONL v3 append.
- `session_turns`, `session_messages`, turn-object, title, label, usage, and reference projections.
- Existing session realtime publication.

It never executes the native provider.

## 4. Domain Model

### 4.1 Terms

- **Cloud replica**: the real `/workspace` mounted in the cloud sandbox.
- **Local replica**: a real user-selected local folder.
- **Candidate snapshot**: an immutable tree observed on one replica but not yet canonical.
- **Canonical snapshot**: the committed logical workspace tree from which execution may start.
- **Applied snapshot**: the canonical snapshot physically materialized on a replica.
- **Common base**: the canonical snapshot from which two candidate trees diverged.
- **Workspace writer lease**: coordination for processes that may mutate workspace files.
- **Session writer lease**: short fenced ownership of CoHub JSONL/DB transcript commit.
- **Native session**: provider-owned local execution history.
- **CoHub session**: product-visible transcript and cloud runtime history.
- **Native binding**: mapping from one device-scoped native session to one current CoHub session branch.
- **Native turn bundle**: immutable provider events/history delta uploaded for one logical turn.
- **Transcript cursor**: a server-owned CoHub session leaf entry and hash-chain position.
- **Mirror fidelity**: `exact`, `history_reconciled`, or `hook_reconstructed`, describing how logical ordering was derived.
- **Mirror completeness**: `complete`, `truncated`, `attachments_unavailable`, or `metadata_only`, describing whether portable content crossed configured boundaries.

### 4.2 Workspace manifest v1

A manifest is RFC 8785 canonical JSON encoded as UTF-8. `manifestSha256` addresses the uncompressed canonical bytes. Transfer uses deterministic gzip (`mtime=0`) and records a separate compressed-object checksum so Go and TypeScript implementations cannot disagree because of compressor metadata.

```ts
interface WorkspaceManifestV1 {
  version: 1;
  spaceId: string;
  replicaId: string;
  snapshotId: string;
  parentSnapshotId: string | null;
  baseCanonicalSnapshotId: string | null;
  workspacePolicyVersion: number;
  executionAttemptId: string | null;
  createdAt: string;
  scanPolicyHash: string;
  treeHash: string;
  entries: WorkspaceEntryV1[];
  gitRepos: GitRepoStateV1[];
  boundaries: Array<{
    path: string;
    replicaId: string;
    mode: "unmanaged_outer" | "same_space_nested";
  }>;
  warnings: WorkspaceScanWarningV1[];
}

type WorkspaceEntryV1 =
  | { path: string; type: "directory" }
  | {
      path: string;
      type: "file";
      size: number;
      sha256: string;
      executable: boolean;
    }
  | { path: string; type: "symlink"; target: string };

interface GitRepoStateV1 {
  path: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  refFingerprint: string | null;
  bundle: { sha256: string; size: number; objectKey: string } | null;
  remotes: Array<{ name: string; url: string; credentialSanitized: boolean }>;
  mode: "git_aware" | "files_only" | "unsupported";
}

interface WorkspaceScanWarningV1 {
  path: string;
  type: string;
  reason: string;
}
```

Manifest invariants:

- `treeHash = SHA256(canonicalJson({ scanPolicyHash, entries, boundaries, portableGitState }))`; ignored files and local-only Git index/stash state are not part of canonical equality.
- Paths are UTF-8, slash-separated, relative, NFC-normalized, and sorted by UTF-8 byte order (not locale collation); parent directories sort before children.
- Empty, absolute, dot-segment, NUL, and root-escaping paths are rejected. A filesystem name that changes under NFC normalization, case folding, or platform canonicalization is reported as a path-normalization conflict rather than silently renamed.
- Directory entries are included so empty directories survive replication; parent directories are included before children and entries are sorted by path/type.
- File identity is SHA-256 of bytes. Mtime is a scan optimization only and is not part of equality. V1 stores one content-addressed blob per file; large blobs use resumable S3 multipart upload/download but are verified as one file hash. Chunk-level dedupe/rolling deltas require a future manifest version.
- Only the executable bit is portable for files. Directory ownership, ACLs, extended attributes, and arbitrary mode bits are not synchronized in v1.
- Only relative symlinks that remain within the replica root are allowed.
- Sockets, devices, FIFOs, and unsafe symlinks are surfaced as warnings and excluded.
- Case-fold and Unicode-normalization collisions block application to a case-insensitive replica. Windows reserved names, trailing dot/space names, unsupported control characters, and platform path-length limits are rejected with `path_unsupported`; the original candidate remains retained and unapplied.
- `.git` files/directories at any depth and `.cohub/system/` are hard exclusions.
- Replication uses the accepted Space policy compiled from platform performance excludes plus the canonical `.cohubignore`. It does not automatically apply `.gitignore`: VCS inclusion and workspace replication are different contracts. The extracted checkpoint scanner keeps its existing `.gitignore` behavior through a separate policy option.
- `.cohubignore` is a managed proposal file. A local/cloud edit is synchronized as content but is not used by scanners until the Space owner/admin confirms the policy transition; API then parses/validates it, updates `space_workspace_policies.custom_excludes` and `policy_version`, and marks the canonical file accepted. Invalid syntax or a newly excluded managed path creates a `scan_policy` conflict. `unmanage` leaves existing bytes in place on attached replicas and never schedules deletion. Policy expansion can add newly managed paths only after the confirmed policy version and a complete stable scan.
- The accepted effective policy and hash are stored in every snapshot. A candidate under a stale/proposed policy is replanned or blocked, never interpreted using unconfirmed rules.
- Likely credential files (`.env*`, private keys, credential/config filenames, and provider token stores inside the root) use `sensitive_content_mode=exclude_with_warning` by default. They remain local/unmanaged and are never deleted by sync. Explicit Space/device consent can switch to `include_with_consent`; the mode and policy version are hashed into the manifest and recorded on the execution attempt.
- Provider homes such as `~/.pi`, `~/.codex`, and `~/.claude` are outside the attached root and are never scanned.

Default limits are explicit and configurable: 2 million entries, 5 GiB per file, 100 GiB per snapshot, and 64 MiB compressed manifest. Exceeding a limit fails the snapshot with an actionable error; it does not silently omit regular files.

### 4.3 Transcript cursor v1

```ts
interface CohubTranscriptCursorV1 {
  version: 1;
  sessionId: string;
  branchEpoch: string;
  leafEntryId: string | null; // latest committed physical barrier/entry
  leafHash: string;
  entryCount: number; // committed logical entries; internal markers are excluded
  lastTurnSequence: number;
  physicalLeafEntryId?: string | null; // recovery/index detail
}
```

Each session entry receives a semantic hash with an explicit domain separator and length-safe framing:

```text
canonicalEntry = RFC8785CanonicalJson(entry)
entryHash = SHA256("cohub-jsonl-entry-v1\\0" || parentHashOrZero32 || uint64be(len(canonicalEntry)) || canonicalEntry)
```

`parentHashOrZero32` is 32 zero bytes for the session header/root. The semantic hash covers the parsed entry, including its server-assigned entry ID, and is stable across harmless JSON object-key ordering differences in historical files. The existing JSONL-safe serializer remains the byte writer (including U+2028/U+2029 escaping and LF delimiting); a separate byte-level file fingerprint/offset detects torn or externally rewritten files. Implement RFC 8785 canonicalization once in a shared protocol/core module with cross-language test vectors rather than relying on ad hoc `JSON.stringify` ordering.

The cursor is cached in a dedicated `session_transcript_state` DB row (`session_id`, `branch_epoch`, visible/physical leaf IDs and hashes, logical entry count, last turn sequence, indexed file size/mtime, updated_at) and a server-owned sidecar index at `<sessions-root>/indexes/<sessionId>.transcript.v1.json`, but JSONL remains the recoverable transcript source. The sidecar records file identity/size, verified byte offset, branch epoch, visible marker ID/hash, logical entry count, and a sparse entry-ID-to-offset index. `branchEpoch` changes on fork, rewind, or compaction rewrite. A missing, stale, or checksum-mismatched sidecar causes a bounded full index rebuild and blocks append until the file and DB projection are reconciled. A cursor from another session or branch epoch is never accepted as an append base; it is resolved through the fork rules. Internal commit markers participate in physical parent/hash recovery but are excluded from model message counts and product sequence counts. Sidecars are disposable caches and are never replicated to local workspaces.

### 4.4 Local hook envelope v1

The raw provider identifier is accepted only over local IPC. `cohub-locald` replaces it with a device-scoped HMAC before upload.

```ts
interface LocalAgentHookEnvelopeV1 {
  version: 1;
  executionAttemptId: string | null; // local UUID allocated at prompt preflight
  eventId: string; // UUIDv7 allocated before local persistence
  observedAt: string;
  deviceId: string;
  replicaId: string;
  provider: "pi" | "codex" | "claude_code";
  providerVersion: string;
  adapterVersion: string;
  identityKeyVersion: number;
  workspacePolicyVersion: number;
  integrationPolicyVersion: number;
  sessionMirrorMode: "full" | "metadata_only" | "disabled";
  nativeSessionKey: string; // Space/replica-scoped HMAC, never the raw provider id
  nativeTurnKey: string | null;
  nativeEventSequence: number | null; // provider sequence when officially exposed
  localReceiptSequence: number; // daemon-local monotonic receipt order
  type:
    | "session_started"
    | "prompt_submitted"
    | "turn_started"
    | "tool_started"
    | "tool_finished"
    | "message_finished"
    | "turn_stopped"
    | "turn_failed"
    | "session_compacted"
    | "session_ended"
    | "provider_exited";
  workspace: {
    relativeCwd: string;
    baseCanonicalSnapshotId: string | null;
    localSnapshotId: string | null;
    leaseEpoch: number | null;
  };
  payload: Record<string, unknown>;
}
```

`provider_exited` is emitted only when CoHub explicitly supervises a provider process. The default native, unwrapped workflow cannot reliably observe a hard-killed provider; stale-turn recovery handles that case.

### 4.5 Native turn bundle v1

```ts
interface SanitizedProviderHistoryEntryV1 {
  nativeMessageKey: string;
  role: "user" | "assistant" | "tool_result" | "compaction";
  content: Array<{
    type: "text" | "thinking" | "image";
    text?: string;
    artifactKey?: string;
    sha256?: string;
    size?: number;
  }>;
  toolCalls?: Array<{
    nativeToolCallKey: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  nativeToolCallKey?: string;
  nativeParentMessageKey?: string;
  toolResult?: {
    isError: boolean;
    content: Array<{
      type: "text" | "image";
      text?: string;
      artifactKey?: string;
      sha256?: string;
      size?: number;
    }>;
  };
  occurredAt?: string;
  usage?: Record<string, number> | null;
}

interface NativeTurnBundleV1 {
  version: 1;
  executionAttemptId: string;
  workspacePolicyVersion: number;
  integrationPolicyVersion: number;
  sessionMirrorMode: "full" | "metadata_only" | "disabled";
  bundleId: string;
  provider: "pi" | "codex" | "claude_code";
  providerVersion: string;
  adapterVersion: string;
  nativeSessionKey: string; // Space/replica-scoped HMAC
  nativeTurnKey: string;
  previousNativeCursor: Record<string, unknown> | null;
  nextNativeCursor: Record<string, unknown>;
  cohubTranscriptBase: CohubTranscriptCursorV1 | null;
  workspaceExecutionBase: {
    executionAttemptId: string;
    canonicalSnapshotId: string | null;
    localSnapshotId: string | null;
    leaseEpoch: number | null;
  };
  events: LocalAgentHookEnvelopeV1[];
  historyDelta: SanitizedProviderHistoryEntryV1[];
  fidelityHint: "exact" | "history_reconciled" | "hook_reconstructed";
  diagnostics: Record<string, unknown>;
}
```

RFC 8785 canonical uncompressed bytes are hashed before upload; deterministic gzip has a separate transport checksum. `(replicaId, bundleId, payloadSha256)` is immutable. Reusing an ID with different canonical bytes is rejected as an idempotency violation.

`historyDelta` is not raw provider JSONL. A versioned collector on the device parses only explicitly supported provider schemas and emits an allowlisted, path-redacted structure whose identifiers are HMACed. If the local collector does not support the observed history version, it uploads no transcript bytes and the server adapter reconstructs from official hook payloads. Raw native transcript files, provider system/developer prompts, hidden context, and config entries never enter the upload object.

## 5. Database Migrations

Migrations are additive. Existing cloud-only Spaces and sessions continue on their current path until a replica is attached.

Do not overload `space_sandboxes` to represent local replicas. Its one-row-per-Space cloud/local sandbox ownership remains unchanged for the existing sandbox control plane; `workspace_replicas` represents additional synchronized filesystem copies. A cloud Space keeps `space_sandboxes.provider='cloud'`. Legacy `provider='local'` Spaces are outside v1 attach and remain on their existing relay behavior.

### 5.1 `local_agent_devices`

| Column                                   | Purpose                                 |
| ---------------------------------------- | --------------------------------------- |
| `id uuid PK`                             | Stable device identity                  |
| `user_uuid varchar not null`             | Owner                                   |
| `display_name varchar not null`          | User-visible device name                |
| `platform varchar not null`              | OS/architecture                         |
| `daemon_version varchar`                 | Last reported locald version            |
| `credential_version integer not null`    | Refresh-token rotation/revocation       |
| `refresh_token_hash text not null`       | Argon2id hash; token returned only once |
| `status varchar not null`                | `active`, `revoked`                     |
| `last_seen_at timestamptz`               | Presence                                |
| `created_at`, `updated_at`, `revoked_at` | Audit                                   |

Indexes: `(user_uuid, status)`, unique active device credential identity.

The daemon exchanges its refresh credential for short-lived device access tokens. Membership is still checked on every Space operation. Hooks never receive either credential.

### 5.2 `space_workspace_policies`

One row per Space defines the canonical managed path policy shared by cloud and all replicas:

- `id uuid PK`, `space_id unique`
- `policy_version bigint not null`
- `default_excludes jsonb not null` (platform/cache patterns)
- `custom_excludes jsonb not null` (Space owner/admin rules)
- `sensitive_content_mode`: `exclude_with_warning`, `include_with_consent`
- `limits jsonb not null` (entry/file/total/manifest limits)
- `updated_by`, `created_at`, `updated_at`

The policy row is locked with `workspace_state` during snapshot verification/promotion. A policy version is part of the snapshot base; a candidate made under an older policy is replanned or rejected, never interpreted using the new rules silently.

The default sensitive policy excludes likely credential files (`.env*`, private keys, credential/config filenames, and provider token stores inside the root) with a visible warning. `include_with_consent` is an explicit Space-level owner/admin decision, not a device-local override. The effective policy and version are included in every manifest hash. Devices cannot add private replication excludes in v1 because that would produce a different canonical tree; a user who will not replicate a managed path must update the Space policy or decline attach. Excluded/unmanaged bytes remain local and are never deleted by sync.

### 5.3 `space_local_agent_policies`

One row per `(space_id, device_id)` records explicit local integration policy:

- `id uuid PK`, `space_id`, `device_id`, `user_uuid`
- `integration_policy_version bigint not null` (incremented on every local integration-policy change)
- `session_mirror_mode`: `full`, `metadata_only`, `disabled`
- `workspace_mode`: `two_way_safe`, `one_way_to_cloud`, `one_way_to_local`, `handoff`
- `offline_enabled boolean`
- `attachment_mode`: `workspace_only`, `approved_external`, `none`
- `max_bundle_bytes`, `max_artifact_bytes`
- `updated_by`, `updated_at`

The API rejects native-content ingest when the current policy is `disabled`; `metadata_only` records lifecycle, provider/version, timing, hashes, and terminal status without user/assistant/tool content, and creates no product-visible `space_sessions`, `session_turns`, JSONL entries, or cloud-continuation claim. Its `native_agent_turns.cohub_session_id/cohub_turn_id` remain null. Policy changes apply only to future bundles; already accepted immutable bundles retain the consent state recorded at upload. Revoking mirroring stops future content uploads and prevents new cloud continuation claims; deletion of already imported transcript/content follows the existing Space/session retention and privacy deletion workflow, with audit evidence, rather than a local daemon attempting remote deletion.

### 5.4 `workspace_replicas`

| Column                                  | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `id uuid PK`                            | Replica identity                                                              |
| `space_id uuid not null`                | Space                                                                         |
| `device_id uuid null`                   | Null for cloud replica                                                        |
| `user_uuid varchar null`                | Local replica owner                                                           |
| `kind varchar not null`                 | `cloud`, `local`                                                              |
| `status varchar not null`               | `attaching`, `ready`, `syncing`, `conflicted`, `offline`, `error`, `detached` |
| `display_name varchar not null`         | UI label                                                                      |
| `root_fingerprint varchar null`         | HMAC of canonical local path, not the path                                    |
| `parent_replica_id uuid null`           | Explicit nested-root boundary owner                                           |
| `boundary_mode varchar null`            | `unmanaged_outer`, `same_space_nested`                                        |
| `protocol_version integer not null`     | Replica protocol                                                              |
| `capabilities jsonb not null`           | Case sensitivity, symlink support, limits                                     |
| `current_snapshot_id uuid null`         | Latest observed candidate                                                     |
| `applied_snapshot_id uuid null`         | Canonical state physically applied                                            |
| `last_common_snapshot_id uuid null`     | Last common canonical base                                                    |
| `active_execution_attempt_id uuid null` | Local writer whose cwd must not receive remote apply                          |
| `last_seen_at timestamptz`              | Presence                                                                      |
| timestamps                              | Lifecycle                                                                     |

Indexes and constraints:

- One cloud replica per Space through a partial unique index.
- One active local binding per `(space_id, device_id, root_fingerprint)`.
- Exact/overlapping roots are validated by locald and API attach checks; PostgreSQL stores the explicit nested boundary because path-overlap exclusion constraints are not portable across deployment versions.
- `device_id` is required for `kind=local` and forbidden for `kind=cloud`.
- Cloud replica creation is idempotent by `(space_id, kind)`; local attach is idempotent by `(space_id, device_id, root_fingerprint, status not detached)`.

### 5.5 `workspace_state`

One row per replicated Space:

| Column                                  | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `space_id uuid PK`                      | Space                                                     |
| `canonical_snapshot_id uuid null`       | Current committed logical tree                            |
| `cloud_applied_snapshot_id uuid null`   | Tree on cloud PVC                                         |
| `generation bigint not null`            | Monotonic canonical generation                            |
| `status varchar not null`               | `initializing`, `ready`, `syncing`, `conflicted`, `error` |
| `active_cycle_id uuid null`             | Current reconcile/apply cycle                             |
| `active_execution_attempt_id uuid null` | Controlled writer currently using the cloud replica       |
| `last_writer_kind varchar null`         | Provenance                                                |
| `last_writer_id varchar null`           | Provenance                                                |
| `updated_at timestamptz`                | State change                                              |

Cloud Agent execution requires `status=ready` and `cloud_applied_snapshot_id=canonical_snapshot_id`.

### 5.6 `workspace_execution_attempts`

One row per controlled local/cloud execution attempt. This is the durable barrier joining workspace and transcript outcomes; `executionAttemptId` must not be inferred by joining timestamps or provider IDs.

- `id uuid PK`
- `space_id`, `replica_id`
- `idempotency_key varchar not null`
- `executor_kind`: `local_native`, `cloud_agent`, `cloud_file_api`, `cloud_command`
- `provider varchar null`
- `session_mirror_mode`, `integration_policy_version`
- `workspace_required boolean not null`, `transcript_required boolean not null`
- `session_id uuid null`, `turn_id uuid null`, `native_agent_turn_id uuid null`
- `relative_cwd text null`
- `base_canonical_snapshot_id uuid null`
- `base_transcript_cursor jsonb null`
- `workspace_lease_epoch bigint null`
- `workspace_policy_version bigint null`
- `status`: `prepared`, `running`, `workspace_sealed`, `transcript_sealed`, `awaiting_recovery`, `completed`, `blocked`, `failed`, `aborted`
- `workspace_cycle_id uuid null`, `native_ingest_id uuid null`
- `result_snapshot_id uuid null`, `result_transcript_cursor jsonb null`
- `started_at`, `completed_at`, `error_code`, `error_message`, `created_at`, `updated_at`

Unique: `(space_id, idempotency_key)`. Unique active attempt per controlled writer lease. An attempt is `completed` only when its required workspace and transcript barriers are both terminal and compatible. `metadata_only` sets `transcript_required=false`; a disabled mirror does not create a native session/turn ingest, but a local workspace execution may still create an attempt with `transcript_required=false` for lease and workspace safety. Cloud/file attempts always require their applicable workspace barrier. A workspace cycle tied to an attempt may be canonicalized, but the cloud execution gate remains blocked while its native ingest is pending/failed or its workspace result is conflicted.

Cloud turns allocate an attempt before Agent execution and store its ID in turn metadata. Locald allocates it after a valid permit and before the native provider prompt. Offline attempts are created locally and registered when connectivity returns. The server validates `relative_cwd` against the canonical snapshot before either executor starts; it never trusts a cwd supplied only in a later hook payload. `idempotency_key` is the client/request identity for cloud attempts and the local `executionAttemptId` for local attempts; retries cannot create a second workspace writer.

### 5.7 `workspace_snapshots`

| Column                                                                  | Purpose                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `id uuid PK`                                                            | Immutable snapshot                                                      |
| `space_id`, `replica_id`                                                | Scope                                                                   |
| `replica_generation bigint`                                             | Per-replica monotonic generation                                        |
| `parent_snapshot_id uuid null`                                          | Previous candidate on this lineage                                      |
| `merge_parent_snapshot_id uuid null`                                    | Second parent for reconciled result                                     |
| `base_canonical_snapshot_id uuid null`                                  | Declared three-way base                                                 |
| `workspace_policy_version bigint not null`                              | Canonical managed-path policy generation                                |
| `manifest_version integer`                                              | Format                                                                  |
| `manifest_object_key text`                                              | Private object                                                          |
| `manifest_sha256 char(64)`                                              | Canonical uncompressed integrity                                        |
| `manifest_transport_sha256 char(64)`, `manifest_transport_bytes bigint` | Compressed object integrity/limits                                      |
| `tree_hash char(64)`                                                    | Logical equality                                                        |
| `file_count bigint`, `total_bytes bigint`                               | Limits/metrics                                                          |
| `source varchar`                                                        | `attach`, `watcher`, `turn_boundary`, `handoff`, `reconcile`, `manual`  |
| `source_session_id`, `source_turn_id`                                   | Optional execution provenance                                           |
| `source_execution_attempt_id uuid null`                                 | Local/cloud execution correlation                                       |
| `lease_epoch bigint null`                                               | Writer fence at capture                                                 |
| `status varchar`                                                        | `uploading`, `uploaded`, `verifying`, `ready`, `rejected`, `gc_pending` |
| timestamps                                                              | Lifecycle                                                               |

Unique index: `(replica_id, replica_generation)`. Add a non-unique lookup index on `(replica_id, tree_hash, manifest_sha256)`; repeated identical trees may still need distinct lineage/provenance rows, so tree identity is not a uniqueness constraint. Canonical and applied roles are represented by `workspace_state.canonical_snapshot_id` and `workspace_replicas.applied_snapshot_id`, not by snapshot lifecycle status. A reconciled result is materialized and rescanned on the cloud replica before its cloud snapshot is promoted canonical.

### 5.8 `workspace_sync_cycles`

Stores one durable reconciliation/apply state machine:

- `id`, `space_id`, `replica_id`
- `base_snapshot_id`, `local_snapshot_id`, `cloud_snapshot_id`
- `result_snapshot_id`
- `execution_attempt_id uuid null`
- `direction`: `local_to_cloud`, `cloud_to_local`, `reconcile`, `initial_attach`, `apply_only`
- `canonical_generation_at_start bigint`
- `plan_object_key`, `plan_sha256`
- `lease_epoch`
- `status`: `planned`, `transferring`, `applying_local`, `applying_cloud`, `verifying`, `completed`, `conflicted`, `failed`, `cancelled`
- `stats`, `error_code`, `error_message`
- `created_at`, `updated_at`, `completed_at`

Only one non-terminal canonical reconciliation/promotion cycle per Space is allowed through a partial unique index. Pull/apply work for already canonical generations is tracked per replica and may proceed concurrently; it does not acquire the canonical promotion slot.

A conflict-free local-to-cloud or merged cycle applies the planned result to the cloud PVC, rescans it, creates a cloud-replica snapshot, and only then updates `workspace_state.canonical_snapshot_id`. A cloud-to-local cycle never promotes a local snapshot; it applies the already canonical cloud snapshot to the local replica and records the local applied ID.

### 5.9 `workspace_sync_conflicts`

Stores recoverable per-path conflicts:

- `id`, `cycle_id`, `space_id`, `path`
- `kind`: `content`, `delete_modify`, `type`, `case_collision`, `path_normalization`, `path_unsupported`, `git_ref`, `scan_policy`
- `resolution`: null, `local`, `cloud`, `merged`, `deleted`, `keep_managed`, or `unmanage`
- `base_entry`, `local_entry`, `cloud_entry`
- Private object keys for retained base/local/cloud bytes where applicable
- `resolved_snapshot_id`, `resolved_by`, `resolved_at`
- timestamps

Unique unresolved conflict per `(cycle_id, path)`. Conflict objects are retained until the Space is deleted plus the normal recovery window.

### 5.10 `workspace_writer_leases`

One fenced lease row per Space:

- `space_id PK`
- `holder_kind`: `cloud_agent`, `local_agent`, `local_offline_reservation`, `cloud_file_api`, `cloud_command`, `sync_apply`
- `holder_id`, `holder_user_uuid`
- `epoch bigint not null`
- `base_snapshot_id`
- `expires_at`, `last_heartbeat_at`, `maximum_duration_at`, `takeover_requires_confirmation`, `updated_at`

Acquire runs in a Postgres transaction, rejects an unexpired competing holder, and increments `epoch`. Every candidate promotion and apply checks the epoch. Controlled cloud execution also holds a PostgreSQL session-level advisory lock, keyed by a domain-separated SHA-256 of the Space UUID, on a dedicated reserved DB connection for its mutation window; a lease expiry cannot grant a second controlled writer access while the old connection/lock is held. Redis may cache presence but is not authoritative.

The lease coordinates writers; it cannot physically fence an arbitrary offline local process. A stale candidate is therefore always reconciled from its recorded base. Takeover is allowed only after the old controlled DB connection/lock is gone, then the new epoch/base is checked.

### 5.11 `session_writer_leases`

One short lease per CoHub session:

- `session_id PK`
- `holder_kind`: `cloud_agent`, `native_ingest`, `fork`
- `holder_id`, `epoch`, `expires_at`, `last_heartbeat_at`

Refactor the existing Redis session lock to use this epoch as a durable ownership record, and use a PostgreSQL session-level advisory lock as the physical append serialization primitive. Derive its two integer keys from a domain-separated SHA-256 of the session UUID, acquire it on a dedicated reserved DB connection, and hold that connection through JSONL append/fsync and projection preparation. Redis remains the low-latency mutex; a new writer never bypasses a held physical lock because a TTL elapsed. After acquiring the lock, it rechecks the epoch, transcript cursor, and JSONL hash before writing. The same physical serialization must cover cloud runtime appends, native ingest, and fork-file provisioning; a fork job cannot copy a session file while another writer is appending.

### 5.12 `native_agent_sessions`

| Column                                | Purpose                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `id uuid PK`                          | Binding                                                             |
| `space_id`, `replica_id`, `device_id` | Scope                                                               |
| `user_uuid`                           | Owner                                                               |
| `provider varchar`                    | `pi`, `codex`, `claude_code`                                        |
| `native_session_key varchar`          | Device-scoped HMAC                                                  |
| `cohub_session_id uuid`               | Current branch                                                      |
| `provider_version`, `adapter_version` | Compatibility/audit                                                 |
| `mirror_fidelity varchar`             | Current ordering/source fidelity                                    |
| `mirror_completeness varchar`         | `complete`, `truncated`, `attachments_unavailable`, `metadata_only` |
| `status varchar`                      | `active`, `ended`, `diverged`, `reconcile_required`, `error`        |
| `binding_generation bigint not null`  | Compare-and-set update fence                                        |
| `native_cursor jsonb`                 | Last accepted provider cursor                                       |
| `cohub_cursor jsonb`                  | Last committed CoHub cursor                                         |
| `last_mirrored_turn_id uuid`          | Fork anchor                                                         |
| `workspace_snapshot_id uuid`          | Last execution result                                               |
| `relative_cwd text`                   | Latest validated path relative to replica root                      |
| `last_seen_at`, timestamps            | Lifecycle                                                           |

Unique active binding: `(space_id, device_id, provider, native_session_key)`. Replica-scoped lookup is indexed separately. Binding updates use compare-and-set on `binding_generation`; a stale device replay cannot move the binding backward to an older CoHub branch/cursor. The home namespace and provider are already included in the HMAC input, so equal provider IDs from separate native stores remain distinct. locald rejects a local-only collision fingerprint that is active under another Space; explicit detach/rebind or a provider-native fork creates a new binding key.

The raw native session ID, provider-home path, and absolute transcript path are never stored server-side. Uploaded HMAC keys are Space/replica-scoped and versioned in local state and server binding metadata; a device revoke invalidates the old key/bindings rather than attempting to recover them from raw provider IDs. Local-only collision fingerprints are deleted only with the local binding/revoke workflow.

Adapter boundary types are explicit:

```ts
interface PortableAgentTurn {
  nativeTurnKey: string;
  relativeCwd: string;
  user: SanitizedProviderHistoryEntryV1;
  messages: SanitizedProviderHistoryEntryV1[];
  terminal: {
    status: "completed" | "interrupted" | "failed";
    errorMessage?: string | null;
  };
  completeness:
    | "complete"
    | "truncated"
    | "attachments_unavailable"
    | "metadata_only";
}

type NativeProviderCursor = Record<string, string | number | boolean | null>;

type AdapterDiagnostic = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

interface NativeTurnCommit {
  ingestId: string;
  bindingId: string;
  nativeTurnId: string;
  turn: PortableAgentTurn;
  expectedCohubCursor: CohubTranscriptCursorV1 | null;
  deterministicEntryIds: string[];
  commitMarkerEntryId: string;
}
```

### 5.13 `native_agent_turns`

This table aggregates prompt/lifecycle/final ingests into one CoHub turn:

- `id uuid PK`
- `binding_id`, `space_id`, `replica_id`
- `execution_attempt_id uuid not null`
- `native_turn_key varchar not null`
- `provider_turn_key varchar null` for the provider-level turn when one provider turn contains more than one prompt
- `cohub_session_id uuid`, `cohub_turn_id uuid`
- `status`: `pending`, `running`, `sealed`, `awaiting_recovery`, `applying`, `applied`, `interrupted`, `cancelled`, `quarantined`
- `terminal_event_kind`: `stopped`, `failed`, `session_ended`, `late_recovery`, `none`
- `recovery_deadline_at timestamptz null`
- `base_cohub_cursor jsonb`, `result_cohub_cursor jsonb`
- `base_workspace_snapshot_id`, `result_workspace_snapshot_id`
- `relative_cwd text`
- `first_event_sequence`, `last_event_sequence`
- `final_ingest_id uuid null`
- `started_at`, `stopped_at`, `created_at`, `updated_at`

Unique: `(binding_id, native_turn_key)` and `(binding_id, execution_attempt_id)`, with one `cohub_turn_id` when assigned. Add `fork_operation_key varchar null` with a unique partial index for automatic divergence forks.

`native_turn_key` is prompt-scoped. When a provider reports multiple submitted prompts under one provider turn ID, the daemon uses the official prompt ID or a deterministic prompt ordinal. Each imported CoHub turn still has one primary user prompt.

### 5.14 `native_agent_ingests`

Durable source of truth for uploaded native batches:

- `id uuid PK`
- `binding_id`, `native_agent_turn_id`, `space_id`, `replica_id`
- `execution_attempt_id uuid not null`, `workspace_policy_version bigint not null`, `integration_policy_version bigint not null`, `session_mirror_mode varchar not null`, `native_turn_key`, `bundle_id`
- `kind`: `lifecycle`, `turn_final`, `history_reconciliation`
- `policy_version integer not null`, `policy_mode varchar not null`
- `payload_inline jsonb null` for canonical lifecycle batches up to 128 KiB
- `payload_object_key null`, canonical `payload_sha256`, uncompressed `payload_bytes`
- `payload_transport_sha256 null`, `payload_transport_bytes null` for object-backed batches
- `base_cohub_cursor jsonb`, `result_cohub_cursor jsonb`
- `base_workspace_snapshot_id`, `result_workspace_snapshot_id`
- `cohub_session_id`, `cohub_turn_id`
- `transcript_entry_ids uuid[]`, `transcript_marker_entry_id uuid null`
- `transcript_visibility`: `hidden`, `visible`, `orphaned`
- `status`: `prepared`, `uploaded`, `verifying`, `committed`, `translating`, `forking`, `appending_jsonl`, `projecting`, `publishing_marker`, `applied`, `failed`, `quarantined`
- `attempt_count`, `next_attempt_at`, `error_code`, `error_message`
- timestamps

Unique: `(replica_id, bundle_id)`. The service also stores the immutable bundle SHA-256 with the identity. An execution attempt may have multiple lifecycle/final/reconciliation ingests, but only one native turn row and one accepted terminal result.

A repeated bundle with the same hash returns the existing ACK. Reusing a bundle ID with different bytes is quarantined. Event overlap across lifecycle/final/reconciliation bundles is deduplicated by `eventId`; the turn row and deterministic transcript identities prevent duplicate CoHub turns/messages.

### 5.15 `native_agent_event_receipts`

Lifecycle events can overlap across prompt, tool, final, and reconciliation bundles. Store a compact receipt for cross-bundle deduplication:

- `id uuid PK`
- `binding_id`, `event_id`, `execution_attempt_id`, `native_agent_turn_id`
- `event_sha256`, `event_sequence`, `event_type`, `first_ingest_id`
- `created_at`

Unique: `(binding_id, event_id)`. Reusing an event ID with a different canonical event hash is quarantined. Receipts are retained at least as long as native ingest bundles and the device replay window.

### 5.16 `session_transcript_state`

One cache/fence row per CoHub session:

- `session_id uuid PK`
- `branch_epoch uuid not null`
- `visible_leaf_entry_id`, `visible_leaf_hash`
- `physical_leaf_entry_id`, `physical_leaf_hash`
- `logical_entry_count bigint`, `last_turn_sequence integer`
- `indexed_file_size bigint`, `indexed_file_mtime timestamptz`
- `sidecar_checksum char(64)`, `status`: `ready`, `rebuilding`, `error`
- `updated_at`

The row is updated only under the physical session writer lock. It is a cache/fence, not an alternate transcript; JSONL plus ingest journal rebuild it. Fork/compaction creates a new `branch_epoch` and writes state only after the new file is atomically visible.

### 5.17 `session_realtime_outbox`

DB projection and Redis realtime cannot share a transaction. Insert one durable outbox row in the same projection transaction for each required persisted-message, turn, fork, label, and notification envelope. Native ingest uses it first; the shared transcript committer then migrates existing cloud persistence publication to the same table.

- `id uuid PK`, deterministically allocated per delivery key
- `delivery_key varchar not null` (ingest/event/entity/revision for native; persisted-event/entity/revision for cloud)
- `ingest_id uuid null`, `space_id`, `session_id uuid null`
- `event_type`, `entity_id`, `revision bigint`, `envelope jsonb`
- `status`: `ready`, `publishing`, `published`, `failed`
- `attempt_count`, `next_attempt_at`, `published_at`, timestamps

Unique: `(delivery_key)`. `revision` is the source entity sequence/version, not wall-clock time. Dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, publishes per-session rows in revision order where possible, and may deliver across sessions in parallel. It publishes the stored stable `RealtimeEnvelope.id` at least once, then marks it published. A crash can duplicate an envelope but cannot lose it. Session/entity reducers treat duplicate IDs/state as idempotent, and reconnect still rebuilds from DB/session snapshot. During migration, a row is either published through the outbox or the legacy direct path, never both.

### 5.18 Existing schema changes

- Extend `SessionTurnExecutionKind` from `"agent" | "direct_generation"` to `"agent" | "native_agent" | "direct_generation"`.
- Do not add internal `awaiting_recovery` to the public `SessionTurnStatus` union. While a native turn is recoverable, map its product `session_turns.status` to existing `running` with `meta.nativeRecovery.status=awaiting_recovery`; map the deadline result to existing `interrupted`, and use the explicitly audited late-recovery transition to existing `completed` only after verified history.
- Native turns use `execution_kind=native_agent`; existing cloud claim SQL continues to claim only `agent` turns.
- `space_sessions.source` is `local_agent` for a native-created root session. Provider, device, fidelity, completeness, consent policy version, and current fork-provisioning state live in `meta.localAgent`/`meta.forkProvisioning`.
- Reuse `provider_message_refs` with provider keys `local_agent:pi`, `local_agent:codex`, and `local_agent:claude_code`. Prefix external conversation identities with `replicaId` and store only HMAC native IDs. Intermediate entries without a `session_messages` row keep the CoHub JSONL entry ID in `meta`.
- Store `executionAttemptId`, workspace/integration policy versions, `workspaceExecutionBase`, `workspaceResult`, local Agent provenance, `mirrorFidelity`, `mirrorCompleteness`, and `usageSource=external` in `session_turns.meta`. Usage aggregation/billing jobs must exclude `execution_kind=native_agent` from CoHub charges while preserving provider-reported usage for display.
- Audit every execution-kind predicate and exhaustive switch in `packages/protocol/src/model/turn.ts`, `packages/core/src/sessions/service.ts`, `apps/api/src/session-turns.ts`, `apps/api/src/space-sessions.ts`, `apps/api/src/routes/spaces/spaces.route.ts`, `apps/api/src/routes/sessions.route.ts`, `apps/api/src/batch.ts`, `apps/agent/src/session.ts`, `apps/agent/src/fork.ts`, `apps/worker/src/tasks/generation-session.ts`, and Web turn rendering/utilities. Cloud claim/steer/abort SQL must continue to select only `agent`; generation jobs must continue to select only `direct_generation`.
- `native_agent` turns are not steerable or remotely abortable in v1. They can be finalized as completed, failed, interrupted, or cancelled by the ingest/recovery processor. Existing fork API must allow a completed native anchor; JSONL branch provisioning copies the visible native branch, while the direct-generation DB-message copy path remains limited to `direct_generation`.
- Automatic fork creation uses a deterministic `forkOperationKey = HMAC(server fork-idempotency secret, "cohub-native-fork-v1" || RFC8785CanonicalJson({ parentSessionId, bindingId, lastCommonTurnId, nativeTurnKey, executionAttemptId }))` stored on `native_agent_turns` and enforced unique. The child session ID is allocated once in the same transaction as the fork record. A retry observes the existing child/fork and resumes ingest there; it never creates a second child. Automatic forks set child `meta.forkProvisioning.status=provisioning` and keep the native turn/binding in `forking` until the branch JSONL working file is fsynced, atomically renamed, cursor-indexed, and verified. Cloud/native execution cannot target the child while provisioning; a failed fork remains retryable with the parent untouched.

### 5.19 Migration and constraint order

Apply migrations in this order, with each step deployable independently:

1. Create device/policy, replica/state, execution-attempt, snapshot/cycle/conflict, and lease tables with `ON DELETE RESTRICT` for immutable provenance rows. Space deletion uses the existing retention workflow and a background purge, not a synchronous cascade.
2. Create native binding/turn/ingest/event-receipt, `session_transcript_state`, and `session_realtime_outbox` tables. Native ingest rows retain the Space/user/device IDs needed for authorization after a binding is detached.
3. Create partial unique indexes concurrently where the deployment migration runner permits it: one cloud replica per Space, one active local root binding, one active canonical-promotion slot, one active controlled execution per lease, one native binding identity, one native turn identity, one ingest bundle identity, and one delivery key.
4. Add `native_agent` to the varchar/check/type boundary for `SessionTurnExecutionKind`; deploy readers before writers so old binaries continue treating unknown turns as non-claimable rather than claiming them as cloud Agent work.
5. Deploy API/worker/Agent code with feature flags disabled, run schema/hash fixture validation, then enable workspace snapshots, native ingest, and providers in that order.
6. Backfill cloud replica/state rows by scanning each opted-in Space once. Backfill transcript cursor/branch-epoch sidecars without changing existing JSONL bytes. A failed backfill leaves the Space cloud-only and retryable.

Foreign keys should connect rows to their Space/device/replica/session/turn where available, but avoid cross-table `ON DELETE CASCADE` that could erase evidence before object retention. Use status transitions (`detached`, `revoked`, `gc_pending`) and an audited purge worker after all retention references are gone.

### 5.20 State transition rules

State transitions are monotonic except for retry counters, lease heartbeat, and retryable `publishing -> ready`/`applying -> planned` recovery:

```text
workspace_snapshot:
  uploading -> uploaded -> verifying -> ready
                    \-> rejected

workspace_state / workspace_replicas pointers:
  canonical_snapshot_id and applied_snapshot_id advance only after the corresponding
  cloud/local apply has been verified; they are not snapshot lifecycle states.

workspace_execution_attempt:
  prepared -> running -> workspace_sealed/transcript_sealed -> completed
                        \-> awaiting_recovery -> transcript_sealed | failed | aborted
                        \-> blocked | failed | aborted

workspace_sync_cycle:
  planned -> transferring -> applying_cloud/applying_local -> verifying -> completed
                                                                  \-> conflicted
                                                                  \-> failed -> planned (retry with new attempt)

native_agent_ingest:
  prepared -> uploaded -> verifying -> committed -> translating -> [forking] -> appending_jsonl -> projecting -> publishing_marker -> applied
                                                    \-> failed -> verifying (retry)
                                                    \-> quarantined

native_agent_turn:
  pending -> running -> sealed -> applying -> applied
                    \-> awaiting_recovery -> applying | interrupted
                                      \-> cancelled | quarantined

realtime_outbox:
  ready -> publishing -> published
                   \-> failed -> ready (backoff)
```

Every transition writes `updated_at`, attempt/error metadata, and the actor/version. A worker may claim a row only with a compare-and-set on the expected prior state and a lease/attempt token. A retry never rewinds a terminal `applied`, `completed`, `cancelled`, or `quarantined` row. `interrupted` is terminal after its recovery deadline, but only a verified provider history reconciliation may perform the explicit audited `interrupted -> applying -> applied` late-recovery transition; ordinary retries cannot do so. On that transition, the product `session_turns` row becomes `completed` with `meta.nativeRecovery.kind=late_recovery` and `previousStatus=interrupted`; the prior interruption event remains immutable in the audit/outbox. A sweeper can move an abandoned `publishing`/`applying` row back to its retryable state only after its heartbeat timeout and after verifying no active worker claim.

## 6. Workspace Replication Protocol

### 6.1 Canonical state machine

A Space with replicas has one canonical logical snapshot. A replica may be:

- **in sync**: `applied_snapshot_id == canonical_snapshot_id`
- **ahead**: it has a candidate based on canonical but not promoted
- **behind**: canonical advanced elsewhere
- **diverged**: both the replica and canonical changed from its common base
- **conflicted**: reconciliation requires user resolution

Only a canonical snapshot can be an online execution base.

### 6.2 Local change flow

Scanner correctness rules are stricter than the current checkpoint convenience scan: permission, `readdir`, `lstat`, `readlink`, open, read, or hash errors for a managed path make the scan `incomplete` and prevent snapshot commit. Only paths explicitly excluded by the effective policy or explicitly unsupported node types may be omitted. A missing file is retried/rescanned because it may be a concurrent rename; it is not silently treated as a deletion until a complete stable scan observes the absence.

Locald uses a bounded worker pool (default 8 hash workers) and cancellation/deadline propagation; it does not use unbounded recursive `Promise.all`/goroutine fan-out. Hash cache entries are reused only when file identity, size, mtime/change-time, and policy version match. Watcher overflow or dropped events force a full scan before any deletion plan.

1. File watcher marks paths dirty, increments a local mutation generation, and debounces for 250 ms.
2. Scanner verifies dirty paths and periodically performs a full scan (at least every 5 minutes, and immediately after watcher overflow/reconnect) to catch missed events. It stats each file before and after hashing and retries if identity, size, mtime, ctime/change-time, or watcher generation changed. A continuously changing tree fails as `workspace_busy`; it never produces a partial snapshot.
3. Daemon builds a candidate manifest with `baseCanonicalSnapshotId` equal to its last applied canonical snapshot and the active `executionAttemptId` when the scan is a turn-boundary result. While an attempt is running, watcher candidates are retained as `candidate_only`; only a sealed turn-boundary scan can enter canonical reconciliation for that attempt.
4. `POST snapshots/prepare` validates descriptor limits and returns a signed manifest upload. After `manifest-ready`, paged blob preparation returns already-present hashes and presigned uploads for missing blobs.
5. Daemon uploads all objects with signed transport checksums.
6. `POST snapshots/commit` confirms object HEAD metadata, records the snapshot as `uploaded`, and returns a durable upload ACK after the DB commit.
7. Workspace worker enforces decompression/schema limits, verifies canonical manifest hash and every referenced blob, then advances the snapshot to `ready` and creates/confirms the sync cycle.
8. Workspace worker loads base, local candidate, and current canonical manifests.
9. Worker produces a deterministic reconciliation plan.
10. If conflict-free and the cycle direction requires cloud mutation, worker applies the result plan to the cloud PVC under the writer epoch, rescans/verifies the cloud tree, creates a cloud-replica snapshot, and only then advances `workspace_state.canonical_snapshot_id` and generation. For an apply-only local cycle, the canonical pointer does not change.
11. Local daemon applies any cloud-side merged operations only when its active execution attempt is sealed/complete, then rescans/verifies and ACKs its applied snapshot.
12. Turn metadata is updated with the result snapshot when the cycle is tied to a turn.

### 6.3 Cloud change flow

1. Existing sandbox `fs.changed` events mark the cloud replica dirty. A periodic scan is the correctness fallback.
2. Workspace worker scans the PVC with the same manifest policy. If a cloud execution attempt is active, watcher candidates are attributed to that attempt; if an untracked process is changing files, the scan is marked unattributed and canonical promotion is blocked until the tree is stable and reconciled.
3. If a valid cloud writer lease is active, the candidate records that lease epoch and execution provenance.
4. If the candidate is based on current canonical and no controlled attempt is active, the worker verifies the cloud tree and advances the canonical pointer only after the cloud-replica snapshot is durable.
5. If it is stale, unattributed, or tied to an active attempt whose turn boundary is not sealed, it remains a candidate or goes through the three-way reconciliation path without promotion.
6. Replica generation notification is published after the canonical pointer/apply state changes, not merely after `fs.changed`.
7. Connected local daemons pull the manifest and missing blobs, stage, apply, verify, and ACK. If a local replica has an active execution attempt, the daemon queues the apply and never writes remote bytes into that provider's active cwd.
8. Disconnected replicas simply remain behind and catch up later.

### 6.4 Three-way reconciliation

For every normalized path, compare base `B`, local `L`, and canonical/cloud `C` by type and content identity:

| Condition                      | Result                      |
| ------------------------------ | --------------------------- |
| `L == C`                       | No operation                |
| `L == B`, `C != B`             | Apply cloud change locally  |
| `C == B`, `L != B`             | Apply local change to cloud |
| `L != B`, `C != B`, `L == C`   | Converged; no conflict      |
| Both changed differently       | Conflict                    |
| Delete versus unchanged        | Propagate deletion          |
| Delete versus edit             | Conflict                    |
| File/symlink/type disagreement | Conflict                    |

For UTF-8 text files up to 1 MiB with a base version, the worker runs pinned `node-diff3`. It normalizes uniform LF/CRLF inputs to LF for comparison, accepts only a clean merge, then writes the base file's uniform line ending/BOM. Mixed line endings, invalid UTF-8, BOM disagreement, or a reported conflict disable auto-merge. Original base/local/cloud bytes remain addressable. Binary files and larger files never auto-merge.

Renames are an optimization inferred from identical hashes. Correctness remains path-based, so missed rename detection becomes add plus delete rather than data loss.

### 6.5 Deletion safety

Borrow the rclone bisync safety model:

- Any cycle deleting more than 1,000 paths or 20% of the previous tree is blocked for explicit confirmation unless it is tied to a valid online writer lease and a verified immediate parent snapshot.
- A sudden empty or near-empty candidate is quarantined.
- Any `incomplete` or unstable scan is quarantined with its error paths and cannot advance `current_snapshot_id` or trigger deletion.
- Deletions are never inferred from an incomplete, unstable, policy-transition, or limit-failed scan.
- A scan-policy change never deletes paths that become newly excluded. The transition is a `scan_policy` conflict requiring explicit `keep_managed` or `unmanage`; the latter records the path as unmanaged and leaves existing bytes in place.
- Deleted content remains in content-addressed storage through the recovery retention window.

### 6.6 Safe apply

Both local and cloud apply use a journaled algorithm:

1. Validate every plan path again against the target root.
2. Download missing blobs into `.cohub/system/sync/staging/<cycleId>`.
3. Verify byte length and SHA-256.
4. Recheck precondition hashes for every affected existing path.
5. Record overwritten/deleted path identities in a rollback journal.
6. Create directory entries, then atomically rename files into place.
7. Apply executable bits and safe relative symlinks.
8. Delete paths deepest first, while retaining directories required by the result manifest.
9. Fsync changed files, journal, and parent directories where supported.
10. Rescan affected paths and verify the target tree hash.
11. Write an applied marker and ACK.
12. Recover or roll back from the journal after a crash.

A precondition mismatch aborts and starts a new scan; it never overwrites the unexpected local change.

### 6.7 Writer coordination

All known cloud mutation paths must use a shared `WorkspaceWriteCoordinator`:

- Cloud Agent turns.
- Cloud shell/run-command tasks.
- API file writes, moves, uploads, and deletes.
- Workspace sync apply.
- Future editor/IDE writes.

For controlled cloud work, the coordinator creates an `executionAttemptId` before starting the Agent/task, attaches `{ attemptId, leaseEpoch }` to every sandbox filesystem mutation and `process.start`, and registers every process ID. The Agent/gateway abort path terminates registered process groups before releasing the lease. The sandbox process manager remains an execution primitive, not the lease authority. A process or editor that is not registered with the coordinator is an unattributed writer: it may run, but its changes cannot be promoted automatically while a controlled attempt is active. The cloud sandbox must reject new CoHub-mediated `process.start`/filesystem mutations without the current attempt token and report active registered process groups during handoff. Existing user-launched processes that bypass CoHub remain an explicit unfenced case and force a stable rescan/reconciliation before promotion.

Online local execution uses the same lease through `cohub-locald`. While an attempt is active, remote apply cycles for that replica are queued; local scans may continue producing candidates, but no cloud change is materialized into the active cwd. Conversely, while a cloud attempt is active, local apply is queued and local candidates cannot be promoted around the cloud lease.

Cloud Agent start requires:

```text
workspace_state.status == ready
cloud_applied_snapshot_id == canonical_snapshot_id
workspace writer lease acquired
```

Local Agent prompt start in strict mode requires:

```text
local replica applied_snapshot_id == canonical_snapshot_id
workspace writer lease acquired
```

Initial online lease values are a 30-second TTL with a 10-second heartbeat; make them server-configurable but identical across clients. An intentional offline reservation has a separately configured maximum duration (default 24 hours), is not renewed after its maximum, and requires explicit takeover after expiry. A SessionStart execution permit holds the online lease for at most 30 seconds without an accepted prompt. Once preflight accepts a prompt, locald marks the lease active, creates/registers the `workspace_execution_attempts` row, sets `workspace_replicas.active_execution_attempt_id`, and renews it until a turn boundary or connectivity loss.

Turn completion captures a result candidate before release. The replica's active-attempt field is cleared only after the attempt reaches a terminal barrier state or is explicitly marked failed/aborted; releasing a lease alone does not allow queued remote apply to race an uncommitted local candidate. If locald loses the lease, it cannot stop an unwrapped native process; it marks subsequent files as a stale-base candidate and never promotes them unconditionally. If a supervised cloud Agent loses lease renewal, the Agent is aborted/interrupted before another writer is admitted. If the provider exits without a boundary hook, the lease expires; the next watcher scan creates an unattributed candidate that must still reconcile from the recorded base.

Lease TTL is a liveness signal, not a physical fencing primitive for arbitrary local processes. For controlled cloud writers, the coordinator holds a physical DB coordination lock for the mutation window; a new controlled writer cannot bypass a held lock merely because its TTL elapsed. On renewal failure, registered cloud processes are aborted and the attempt becomes `aborted` before takeover. Local unwrapped processes remain the explicit exception and are handled as stale candidates.

### 6.8 Git semantics

`.git` is not ordinary replicated file content. Synchronizing Git lock files, indexes, object packs, and refs byte-for-byte is unsafe.

Reuse and extract the existing checkpoint Git support in `apps/worker/src/checkpoint/git-bundles.ts`:

- Discover repositories while scanning.
- Record HEAD, branch, dirty state, sanitized remotes, and ref fingerprint.
- Store content-addressed `git bundle` objects.
- Never transfer credential-bearing remote URLs.

Initial materialization can reconstruct a repository from a bundle. Subsequent transfer fetches objects into a replica namespace such as `refs/remotes/cohub-replica/<replicaId>/...`.

Branch movement rules:

- Fast-forward a checked-out branch only when its old HEAD is an ancestor, the worktree preconditions match, and no local commit would be discarded.
- Divergent commits create a `git_ref` conflict. Never force-update or reset a branch.
- Uncommitted working-tree content is still synchronized by the normal manifest.
- Index and stash state remain local.
- Git credentials, hooks, config, reflogs, and worktree administration remain local.
- Empty/unborn repositories are recreated explicitly without requiring a bundle.
- Nested repositories and submodules are separate `GitRepoStateV1` records. Their working trees use normal file replication; their Git identities use bundle/ref rules.
- A `.git` indirection that points outside the replica root, including a linked worktree, is reported as unsupported in v1 and blocks Git-aware handoff. It is never followed implicitly.
- Git LFS working-tree bytes are normal workspace files. LFS object stores and credentials are not copied, and CoHub does not run `git lfs fetch` automatically in v1; users/providers may run it with each replica's own credentials.
- If the canonical tree contains Git repositories but Git is unavailable locally, attach fails unless the user explicitly selects a files-only replica. Files-only mode is labeled and cannot claim Git-state parity.

### 6.9 Checkpoints

Workspace snapshots are operational and should not spam user-visible checkpoint history.

Asynchronously create or deduplicate an existing CoHub checkpoint at these boundaries; canonical snapshot promotion does not wait for Gitea/checkpoint publication, and a checkpoint failure is retained for retry and surfaced without rolling back the canonical files:

- Completed Agent turn whose result changed the canonical workspace.
- Explicit local-to-cloud or cloud-to-local handoff.
- Before a destructive initial attach choice.
- Explicit user save.

Use `checkpoints.meta.source` values such as `native_agent_turn`, `cloud_agent_turn`, and `workspace_handoff`, with source session/turn/snapshot IDs. Reuse existing asset and Git bundle objects where hashes match.

## 7. Native Session Mirror Protocol

### 7.1 Directionality

The production contract is:

```text
provider native session -> CoHub session JSONL/DB/realtime
```

It is not:

```text
provider native session file <-> CoHub JSONL file
```

Cloud turns remain in CoHub. They are not injected into an existing native provider session. A future explicit provider-specific export/import feature may create a new native session, but it must not change this contract or claim implicit synchronization.

### 7.2 Session creation and binding

`SessionStart` creates only a local pending mapping. The server creates a CoHub session on the first `prompt_submitted` event, avoiding empty product sessions.

The new CoHub session has:

- `source=local_agent`
- owner equal to the authenticated device user
- title derived by the existing first-prompt title path
- `meta.localAgent` containing provider, device display name, adapter version, fidelity, completeness, and the consent/policy mode used for the imported turn
- a normal JSONL v3 header with CoHub session ID, the safe cloud-equivalent execution cwd, and affinity

Resuming the same native provider session reuses its binding through the HMAC native session key. `SessionEnd` marks the binding paused/ended for observability, not deleted; a later official resume event can reactivate it if the device/Space policy still permits. Explicit detach or device revoke is terminal for that binding. On first observing a pre-existing provider session, the CLI offers two explicit choices: `import-history` (only when the local collector supports the provider/version and the user consents) or `start-at-next-prompt` (default). The latter sets the native cursor at the current native leaf and does not backfill older private history. A native session key already bound to another active Space/replica on the same device requires an explicit detach/rebind; it is never silently attached to two CoHub sessions.

`relativeCwd` is validated inside the attached root and stored per turn. Cloud runtime keeps `/workspace` as the workspace scope but starts process/file-relative operations from `/workspace/<relativeCwd>`. If that directory no longer exists in the applied canonical snapshot, execution is blocked with an actionable error; it does not silently fall back to another cwd.

### 7.3 Turn lifecycle

When online, a `prompt_submitted` lifecycle ingest resolves the unique `native_agent_turns` row and its `workspace_execution_attempts` row, creates a `native_agent` CoHub turn with status `running`, and publishes `session.turn.created`. The provider hook still does not wait for this network operation. A final bundle arriving first performs the same creation idempotently. If the consent policy is `metadata_only`, the attempt remains metadata-only and no CoHub turn/session is created.

At `turn_stopped` or `turn_failed`, the sealed turn bundle is processed. The committer:

1. Acquires the fenced CoHub session writer lease.
2. Resolves or creates the binding and target branch.
3. Compares the binding's CoHub cursor with the target session leaf.
4. Forks if the leaf advanced beyond the binding anchor.
5. Runs the provider adapter.
6. Validates a coherent logical message sequence.
7. Appends deterministic JSONL entries durably.
8. Projects the user/final messages, intermediate/tool objects, usage, turn terminal state, and stable realtime outbox envelopes in one DB transaction.
9. Advances the binding's native and CoHub cursors.
10. Marks the ingest `applied` and returns an ACK.
11. Dispatches existing message/turn/fork realtime event types from the durable outbox; realtime completion is not required for the ingest ACK because clients can reload committed DB state.

For an offline turn, the same processor creates and finalizes the turn in one job while retaining the original observed timestamps. It first registers the locally allocated execution attempt; if the server observes that the attempt key was already used with a different base or policy version, it quarantines the bundle instead of merging by timestamp.

Native turn-key rules are provider-specific but produce one prompt-scoped key:

- Pi allocates a UUID at the accepted `input` event and persists a per-native-session prompt ordinal; `turn_start`/`turn_end` and `agent_settled` attach to that key. Extension commands and `input` events returned as `handled` create no turn.
- Claude uses `prompt_id` when present. A supported Claude version without `prompt_id` is rejected for full mirroring; metadata-only observation can still record the session lifecycle.
- Codex uses `turn_id`; if one Codex turn contains multiple user boundaries, the collector derives a deterministic prompt ordinal from the observed event sequence and stores it in `native_turn_key`. Concurrent hook arrival order is never used as the sole boundary.

A final/history bundle may arrive before its prompt lifecycle bundle. The server creates the turn/attempt from the final bundle idempotently, then attaches a late lifecycle event if its execution-attempt and native-turn keys match. A lifecycle event that cannot be matched is retained as an orphan diagnostic and never creates a second user turn.

If Web submits while an online native turn is running, API creates a normal cloud `agent` follow-up turn but never treats it as a steer/abort instruction to the native provider. Agent claim waits for the native ingest and workspace execution gate. The cloud turn starts only after the native transcript is committed and the cloud workspace has applied its result snapshot. If the server did not know about an offline native turn, cloud may proceed from its known head; the later native ingest forks as specified instead of rewriting sequence order.

Provider commands such as local help/config/compact commands may emit `UserPromptSubmit` without producing a logical model turn. The adapter marks the provisional native turn `cancelled`; no empty user/assistant entries are appended. A newly created CoHub session with no visible logical turn is removed by the same idempotent cleanup path.

### 7.4 Portable logical sequence

CoHub JSONL v3 remains the cloud Pi runtime transcript. The provider adapter therefore emits Pi-compatible `AgentMessage` records even for Claude/Codex input; it does not write Claude or Codex-native records into the CoHub file. The adapter preserves provider provenance in `meta` and maps portable facts as follows:

- user -> Pi `user` message;
- assistant text/thinking/tool calls -> Pi `assistant` message with `text`, allowed `thinking`, and `toolCall` blocks;
- tool result -> separate Pi `toolResult` message with the mapped tool-call ID and sanitized content;
- compaction -> Pi `compactionSummary`/CoHub compaction entry only when the provider summary is explicit and bounded;
- provider-only system/developer/config/reasoning-signature records -> omitted from portable context and retained only as non-semantic diagnostics where allowed.

The adapter must validate the resulting Pi `AgentMessage` union against the exact version of `@earendil-works/pi-agent-core` used by the cloud Agent before JSONL append. A provider turn that cannot be represented without inventing context is quarantined or explicitly degraded to an interrupted/hook-reconstructed turn; it is never written as arbitrary JSON. In `metadata_only` mode, the adapter validates lifecycle/order and hashes but emits no portable messages or JSONL entries.

Every accepted turn must normalize to:

```text
user
assistant(toolCall...)?
toolResult...
assistant(toolCall...)?
toolResult...
assistant(final text or terminal error)
```

Validation requires:

- Exactly one primary user prompt per imported CoHub turn. A reconciliation bundle containing multiple user boundaries is deterministically split into multiple `native_agent_turns` rows.
- Unique portable tool call IDs within a CoHub session. Provider IDs are HMACed for refs and remapped to a conservative CoHub ID format while preserving tool-call/result pairing.
- Every tool result references a prior tool call in the same imported turn.
- A terminal assistant result, interruption, or explicit failure.
- Serializable and size-bounded content.
- No provider model-change entry that could switch the cloud runtime model.
- No provider system/developer prompt, local hook-injected context, credential/config block, or hidden provider state. Only user, assistant, tool, approved attachment, and explicit compaction-summary facts are portable. Provider reasoning/thinking content is portable only when the provider officially exposes it as an ordinary message block and the local collector policy allows it; hidden/encrypted reasoning signatures are metadata or omitted, never interpreted as prompt content.

Provider/model are stored on messages and turn metadata for provenance. CoHub cloud continuation still selects its model through the normal request profile. Portable tool IDs are deterministic CoHub-safe IDs derived from the HMAC native tool key; the mapping is retained in `provider_message_refs`/entry metadata so retries and fork reconciliation preserve pairing without exposing raw IDs.

Projection deliberately preserves the current representation split:

| Logical fact               | CoHub JSONL v3                              | Postgres/product projection                                                                                                        |
| -------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| User prompt                | Pi `user` message entry                     | one `session_messages.role=user` row and `session_turns.user_*`                                                                    |
| Assistant requesting tools | Pi `assistant` entry with `toolCall` blocks | `role=assistant`, `meta.messageKind=assistant_intermediate`, normalized `tool_use` blocks                                          |
| Tool completion            | separate Pi `toolResult` entry              | normalized `tool_result` blocks and turn-object/intermediate files; never a new unsupported `session_messages.role=toolResult` row |
| Final assistant            | Pi `assistant` terminal entry               | `role=assistant`, `assistant_final`/`assistant_error`, plus terminal `session_turns` fields                                        |
| Compaction                 | JSONL compaction/summary entry              | existing compaction intermediate/meta projection                                                                                   |

This is why the implementation must reuse `normalizeAssistantTurn`, intermediate-object storage, and turn finalization rather than bulk-inserting provider messages directly into `session_messages`.

### 7.5 JSONL and projection atomicity

Postgres and the session filesystem cannot share a transaction. `native_agent_ingests` is the immutable write-ahead journal, while `native_agent_turns` is the durable aggregation/idempotency record for lifecycle and final bundles.

Use deterministic UUIDv5 (or SHA-256 truncated to RFC 9562 UUID form with an explicit domain) derived from `(bindingId, native message key, content hash)` for JSONL entries and existing DB idempotency keys for projected messages. Commit marker IDs use the same deterministic UUID scheme, so `transcript_entry_ids uuid[]` is type-safe and retries cannot allocate a second physical identity. Event receipts deduplicate the same lifecycle fact across bundles before turn aggregation. Every native JSONL message entry carries `meta.cohubNativeIngestId=<ingestId>`. The committer also writes a deterministic internal `custom` JSONL entry named `cohub_transcript_commit` whose data contains the ingest ID, entry IDs, final entry hash, previous visible barrier ID, and protocol version. `CohubTranscriptReader` treats native entries as hidden until their commit marker is present; the marker itself is ignored by model context, product message projection, and ordinary UI. This is a visibility barrier, not provider content.

Commit markers form a contiguous physical barrier chain. A marker is accepted only if all referenced entries are present, the previous marker/visible leaf matches, and the ingest is in the DB `projecting`/`publishing_marker` state. Legacy/cloud entries without `cohubNativeIngestId` remain visible under the existing JSONL rules; only native batches require a marker barrier. A later marker cannot make an earlier unmarked batch visible. The logical cursor reports the latest committed marker/leaf and the latest visible turn sequence; physical recovery retains the marker IDs separately.

Processing order is:

1. Persist and verify the immutable ingest payload.
2. Under the physical session writer lock, append missing deterministic native entries as complete LF-delimited records, flush, and fsync the file descriptor. Existing trailing-partial recovery archives and repairs a torn final record. Set `transcript_visibility=hidden`.
3. Upsert event receipts, turn aggregation, DB projection, provider refs, binding cursor, and stable realtime outbox envelopes in one transaction. Set ingest state to `publishing_marker` only after the transaction commits.
4. Append the deterministic `cohub_transcript_commit` marker, flush/fsync, and update the sidecar cursor/index. Set `transcript_visibility=visible` and ingest state `applied`.
5. Dispatch outbox envelopes at least once and mark each published.

A crash after native JSONL append but before DB commit leaves entries without a marker; Reader, fork provisioning, and cloud execution ignore them. Replay reuses the same entry IDs and completes the DB projection. A crash after DB commit but before the marker leaves DB state durable but keeps the transcript batch hidden; the sweeper reacquires the session lock and writes the marker before allowing cloud execution. A crash after the marker but before ACK returns the existing applied ACK. A crash around Redis publish may duplicate a stable realtime envelope but cannot lose committed state, the marker, or its pending outbox row.

Cloud execution is gated while a committed native ingest for that session is in `appending_jsonl`, `projecting`, or `publishing_marker`, or while a hidden/orphaned marker breaks the contiguous barrier chain. `CohubTranscriptReader`, `SessionManager.buildSessionContext`, `createBranchedSession`, and fork provisioning must all use the same visibility filter; no caller may read raw native entries directly. A repair job can append/reconstruct a missing marker only from the immutable ingest row and exact entry hashes; it cannot mark arbitrary JSONL bytes visible.

The existing cloud turn claim path must check this gate in the same transaction that claims a queued `agent` turn: lock `workspace_state`, active `workspace_execution_attempts`, and session ingest state; require `workspace_state.status=ready`, cloud applied equals canonical, no active local writer/attempt or unexpired `local_offline_reservation`, and no pending hidden native barrier. If blocked, leave the cloud turn queued with a structured `workspace_wait` reason and retry time; do not claim it and then fail as a provider error.

### 7.6 Transcript reader and committer refactor

Extract from `apps/agent/src/runtime/local-session-manager.ts`, `session.ts`, and `persistence.ts`:

```ts
interface CohubTranscriptReader {
  open(sessionId: string): Promise<{
    header: SessionHeader;
    cursor: CohubTranscriptCursorV1;
    entries: SessionEntry[];
    hiddenNativeIngestIds: string[];
  }>;
  findLatestVisibleAgentEntryId(
    sessionId: string,
    turnId: string
  ): Promise<string | null>;
}

interface CohubTranscriptCommitter {
  appendNativeTurn(input: NativeTurnCommit): Promise<{
    cursor: CohubTranscriptCursorV1;
    turnId: string;
    messageIds: string[];
  }>;
}
```

The existing cloud runtime continues to use the same underlying writer. This removes the current assumption that only a live Pi runtime can produce valid session entries. The visibility filter is shared by runtime context construction, transcript cursor calculation, session fork copy, and reconciliation tooling; raw JSONL parsing remains an internal recovery primitive, not an execution context API. Add explicit-ID append methods for native entries and commit markers; they must verify parent/leaf preconditions and fsync through a file handle. Fork provisioning uses the same physical session lock and a `.forking` working file/atomic rename pattern already used by `apps/agent/src/fork.ts`.

The committer must split current side-effectful helpers into transaction-aware primitives: `createSessionTurnTx`, `persistMessageNodeTx`, `finalizeSessionTurnTx`, `upsertProviderMessageRefTx`, `insertSessionRealtimeOutboxTx`, and `appendTranscriptCommitMarker`. The native path calls the DB primitives inside one transaction and invokes title/reference/postprocess queues only after commit; it calls the marker primitive while holding the physical session lock. Existing public cloud helpers can retain their signatures while delegating to the new primitives; no native ingest may publish realtime or enqueue a derived job before its transaction commits.

### 7.7 Fork rules

Fork in all of these cases:

- The CoHub leaf or `branchEpoch` advanced after the binding's last mirrored anchor. This changes the transcript target only; workspace reconciliation still uses the execution attempt's workspace base/current canonical snapshot.
- The provider rewound or branched its native history and the new native cursor is not a descendant of the accepted cursor.
- The same native session is resumed from a restored/older provider transcript.

Anchor at the latest mapped completed CoHub turn that is common to both histories, resolving visibility through `session_turn_segments` rather than assuming the turn is physically owned by the current session file. If a native rewind occurs inside a turn, anchor at the previous completed turn and import the changed turn into the child. If the parent contains a queued/running turn at the intended insertion point, wait for terminal resolution or quarantine with `native_parent_running`; never append around an in-flight turn. If no common mapped completed turn exists, quarantine the ingest as `reconcile_required` and create no ambiguous append. Never delete or rewrite an already visible CoHub turn.

### 7.8 Compaction and history rewrite

A provider byte offset is only an optimization, never the identity cursor.

Adapters track provider entry IDs where stable, content hashes where not, and a file identity/size fingerprint. If a transcript is compacted or rewritten:

- Reconcile logical entries against existing provider refs.
- Import a provider summary as a CoHub compaction/custom entry when available.
- Preserve already imported CoHub history.
- Fork if the provider's active logical branch changed.
- Mark `reconcile_required` instead of guessing when no common logical anchor can be established.

### 7.9 Attachments, large output, and usage

- Files inside the attached workspace are referenced through workspace snapshots.
- Native session attachments are uploaded as private content-addressed session objects only when `attachment_mode` permits them and the local collector can read them safely.
- Absolute paths are converted to workspace-relative paths or redacted.
- Files outside the attached root are not uploaded by default. The mirrored turn records an explicit unavailable-local-attachment block instead of silently omitting context. `attachment_mode=approved_external` requires a separate per-file approval/token and uploads only the selected file as a sanitized private artifact; it never expands the workspace replica root.
- Tool output is bounded to 4 MiB per result and 32 MiB per turn in CoHub JSONL. Larger allowlisted output is moved to a private sanitized session artifact; JSONL includes an explicit truncation marker, SHA-256, size, and artifact reference metadata.
- A sanitized turn bundle is limited to 256 MiB uncompressed and a separate session artifact to 5 GiB, subject to Space quota. Content beyond those boundaries remains local with a hash/size diagnostic and `mirrorCompleteness=truncated`; it is never silently reported as fully mirrored.
- Provider usage is stored only when officially exposed. Missing usage remains null and is not estimated.
- Local provider usage is marked external and is not charged through CoHub billing.

## 8. Provider Adapters

Provider capability baseline, verified against the official provider interfaces available on 2026-08-26:

- [Pi extensions](https://pi.dev/docs/extensions)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://developers.openai.com/codex/hooks/)

| Provider    | Session correlation                              | Turn correlation                     | Primary terminal signal                                                   | Tool facts                                                         | Native history reliability                                      | Declared fidelity                                                        |
| ----------- | ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pi          | extension session lifecycle/native entry lineage | `input`/turn event or daemon ordinal | `agent_settled`/turn boundary plus exact active-branch messages           | exact Pi `toolCall` and `toolResult` messages                      | native extension/session API is the adapter contract            | `exact` for supported versions                                           |
| Claude Code | `session_id`                                     | `prompt_id` on v2.1.196+             | `Stop.last_assistant_message` or `StopFailure`                            | Pre/Post/Failure/Batch hooks, enriched by history                  | transcript is documented but asynchronously written and may lag | `history_reconciled` or `hook_reconstructed`                             |
| Codex       | `session_id`                                     | `turn_id`                            | `Stop.last_assistant_message`; SessionEnd/stale recovery for missing Stop | Pre/Permission/Post hooks, enriched only by tested parser versions | Codex explicitly says `transcript_path` format is not stable    | `history_reconciled` for tested versions, otherwise `hook_reconstructed` |

No provider guarantees a terminal hook after process or machine failure. Durable local spooling, stale-turn recovery, and later history reconciliation are therefore part of correctness, not optional enhancements.

Each provider integration has two version-locked halves:

1. A **local collector** in `cohub-locald` consumes official hook input and, only for supported schemas, extracts an allowlisted native history delta. It owns path redaction and HMAC identity replacement.
2. A **server adapter** in `apps/agent` reconciles those sanitized facts, validates lifecycle/order, and emits portable CoHub turns.

The pair shares protocol fixtures and an `adapterVersion`. Adapter compatibility is an explicit matrix of `(provider semver range, locald protocol range, collector adapterVersion, server adapterVersion, Pi AgentMessage schema version)`. The API returns accepted ranges during attach/doctor; locald refuses `full` mirroring when no row matches. A server never asks an older collector to upload a raw transcript for forward compatibility. The local collector applies provider-specific path redaction, configured credential-pattern redaction for tool arguments/results, attachment limits, and schema validation before an entry can enter the spool. Redaction emits a diagnostic and `mirrorCompleteness=truncated` when it changes portable content.

Server adapters implement:

```ts
interface NativeProviderAdapter {
  provider: "pi" | "codex" | "claude_code";
  supports(providerVersion: string, adapterVersion: string): boolean;
  reconcile(
    input: NativeTurnBundleV1,
    prior: NativeProviderCursor | null
  ): Promise<{
    nativeCursor: NativeProviderCursor;
    turns: PortableAgentTurn[];
    fidelity: "exact" | "history_reconciled" | "hook_reconstructed";
    diagnostics: AdapterDiagnostic[];
  }>;
}
```

Unsupported versions are quarantined with an actionable upgrade/adapter error. They are not parsed optimistically. Provider version detection comes from the provider's official version command/hook field; a missing or unparseable version disables history parsing and permits only an explicitly supported hook-reconstructed or metadata-only mode.

All lifecycle hooks are observational and fire-and-forget after local durable spooling, except the strict-mode `UserPromptSubmit` preflight decision. That decision consults only daemon-local permit state and returns within 100 ms; it never waits for a server response. `SessionStart` and explicit `cohub workspace handoff local --wait` prepare the permit ahead of the prompt.

### 8.1 Pi first

Pi is the first production adapter because its extension API exposes the strongest lifecycle and its message model matches current CoHub JSONL.

Install a user-scoped Pi extension that listens to the supported equivalents of:

- `session_start`, `session_shutdown`
- `input` for local permit preflight (return `handled` when the permit is not valid; never transform the prompt)
- `agent_start`, `agent_end`, `agent_settled`
- `turn_start`, `turn_end`
- `message_start`, `message_end`
- tool execution start/end
- compaction/session branch changes where available

The extension's `input` handler performs only an owner-local IPC preflight against the cached execution permit. It does not inject a message or modify Pi's system prompt. If strict mode is enabled and the permit is absent/stale, it returns `{ action: "handled" }` and displays the short handoff error; it never waits for network. This preflight is enabled only for Pi versions whose tested extension contract supports `input` interception; otherwise the CLI handoff command is mandatory and the extension remains observational. At turn end, the extension exports the exact active-branch `AgentMessage` delta since the last acknowledged native cursor:

- user message
- assistant messages with native tool calls
- independent tool results
- final assistant message
- provider/model/usage metadata exposed by Pi

The extension writes only to local IPC. It receives no CoHub prompt or tool.

Pi acceptance requires `mirror_fidelity=exact` and `mirror_completeness=complete` for ordinary within-limit turns, plus cloud Pi continuation from the resulting CoHub JSONL. Pi assistant tool calls map directly to `tool_use` blocks and each result maps to a separate `tool_result` message, preserving source order even when tools execute in parallel.

### 8.2 Claude Code

Require Claude Code v2.1.196 or newer for stable `prompt_id` turn correlation. Install user-scoped hooks in `~/.claude/settings.json` or a CoHub plugin; never write project hook files by default.

Capture:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`, `PostToolUseFailure`, and `PostToolBatch`
- `Stop` and `StopFailure`
- `PreCompact` and `PostCompact`
- `SessionEnd`
- `CwdChanged` and `DirectoryAdded` for relative-cwd/root validation

Claude documents that `transcript_path` may lag the in-memory conversation. Therefore:

- `last_assistant_message` from `Stop` is authoritative for terminal text. The collector records `stop_hook_active` and does not seal a turn from a continuation attempt until the provider reports the final stop state. A `UserPromptSubmit` preflight hook may return the provider's documented blocking decision when the daemon-local permit is absent; it must not wait for network or inject CoHub context.
- The daemon polls the transcript for stable size/content after Stop without blocking the hook: two stable reads 250 ms apart, bounded to 5 seconds.
- A versioned local collector extracts and sanitizes assistant/tool rounds when supported; the paired server adapter reconciles them with hooks.
- Hook events reconstruct a valid reduced turn when history reconciliation is unavailable.
- Subagent events are attached as intermediate metadata to the parent turn; they do not create independent top-level CoHub sessions in v1.

Fidelity is `history_reconciled` when the supported transcript parser agrees with hooks, otherwise `hook_reconstructed`. Claude `tool_use`/`tool_result` facts map to portable entries only after the local collector redacts paths and configured credential patterns. Added working directories outside the attached replica are not synchronized; the turn records an unavailable-external-directory diagnostic, and strict mode can block if the provider attempts to switch its primary cwd outside the root.

### 8.3 Codex

Install user-scoped `~/.codex/hooks.json` or a CoHub plugin. Codex requires the user to review and trust non-managed hooks; installation must instruct the user to verify the exact hook in `/hooks`. CoHub never uses `--dangerously-bypass-hook-trust` automatically.

Capture:

- `SessionStart`, `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`, `PermissionRequest`, `PostToolUse`
- `PreCompact`, `PostCompact`
- `Stop`
- subagent start/stop as intermediate metadata

Use Codex's `turn_id` as the native turn key. Codex command hooks for the same event can run concurrently and do not provide a universal causal sequence, so `localReceiptSequence` is diagnostic only and arrival order is never treated as logical order. The collector records a provider sequence only when the provider officially exposes one; otherwise tool IDs, event type, timestamps, and supported history reconciliation determine logical order.

Codex explicitly documents that `transcript_path` is not a stable hook interface. Therefore:

- Hooks are the primary contract.
- No generic parser is allowed.
- A paired local collector/server parser is enabled only for explicitly tested Codex version ranges and fixture schemas.
- `last_assistant_message` on Stop is the terminal fallback. The collector records `stop_hook_active` and deduplicates repeated Stop invocations by event identity/turn key. A `UserPromptSubmit` preflight hook may return `continue: false` with an actionable local handoff reason when the daemon-local permit is absent; it must not wait for network or add model-visible context.
- Unsupported history formats still produce a valid `hook_reconstructed` CoHub turn from prompt/tool/Stop events when those facts are present. Codex tool input/output maps to portable `tool_use`/`tool_result` blocks; if a tool call cannot be paired deterministically, the turn is quarantined or marked interrupted rather than emitting an unpaired successful tool result.

### 8.4 Missing or failed hooks

Hooks are observational and cannot guarantee events after `kill -9`, machine loss, or provider bugs.

Recovery policy:

- Daemon retries unacknowledged local events indefinitely within local retention.
- `SessionEnd` or provider shutdown moves an open turn to `awaiting_recovery` when no Stop arrived; it does not immediately claim a successful terminal result.
- A server stale-turn sweeper moves an online mirrored turn to `awaiting_recovery` after lease expiry and an adapter-specific inactivity period, with a visible recovery state and deadline.
- On the next event, history reconciliation attempts to recover the missing completed turn while it is recoverable.
- After the recovery deadline, CoHub commits `interrupted` as the final state. A later verified history result may use the explicit audited late-recovery transition, changing the product turn to `completed` with a visible `late_recovery` marker while preserving the prior interrupted event; an unverified result creates no successful replacement.
- If final content cannot be proven, CoHub shows an interrupted turn; it never fabricates a successful assistant response.

### 8.5 Hook installation behavior

Generated provider configuration separates fast preflight from observational export:

| Provider    | Preflight handler                                                     | Observational handlers                                                                             | Hook process contract                                             |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Pi          | tested `input` extension interception; otherwise explicit CLI handoff | lifecycle/message/tool/settled extension events                                                    | extension sends local IPC and returns; no network                 |
| Claude Code | synchronous `UserPromptSubmit` command using daemon-local permit only | SessionStart, tool, Stop/StopFailure, compaction, SessionEnd commands marked async where supported | command spools stdin locally; Stop reconciliation runs in daemon  |
| Codex       | synchronous `UserPromptSubmit` command using daemon-local permit only | SessionStart, tool, compaction, Stop/SessionEnd commands; async where supported                    | command spools stdin locally; never returns model-visible context |

Preflight definitions never use a network timeout as a permission decision. Observational hook definitions never return CoHub context or provider-control output. Generated entries carry an owned marker/version so upgrades and uninstall are exact and idempotent.

### 8.6 Provider doctor

```bash
cohub agent hooks doctor [pi|claude|codex]
```

Doctor verifies:

- Provider version and adapter compatibility.
- Hook/extension source and exact command path.
- Codex trust/enabled state when observable.
- Local daemon socket and spool permissions.
- Attached-root matching.
- A synthetic hook round-trip that contains no provider credentials.
- Last provider event and last server ACK.

## 9. External API Contract

All endpoints use short-lived device access tokens and verify the user still has write access to the Space.

### 9.1 Device and replica

```text
POST   /v1/local-devices/enroll
POST   /v1/local-devices/token
DELETE /v1/local-devices/:deviceId

POST   /v1/spaces/:spaceId/workspace-replicas
GET    /v1/spaces/:spaceId/workspace-state
GET    /v1/spaces/:spaceId/local-agent-policy
PUT    /v1/spaces/:spaceId/local-agent-policy
GET    /v1/workspace-replicas/:replicaId
DELETE /v1/workspace-replicas/:replicaId
POST   /v1/workspace-replicas/:replicaId/attach/prepare
GET    /v1/workspace-replicas/:replicaId/events?after=<generation>
```

The events endpoint is a narrow SSE/control stream. Locald also polls replica state with an ETag, so disconnects cannot lose generations. `workspace-state` returns the canonical snapshot ID/generation, cloud-applied ID, active writer/attempt, conflict count, and protocol/policy versions without file content. `attach/prepare` creates an initial cloud-to-local apply cycle and returns signed manifest/blob downloads; it never overwrites a non-empty local root without the explicit attach choice.

### 9.2 Snapshot transfer

```text
POST /v1/workspace-replicas/:replicaId/snapshots/prepare
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/manifest-ready
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/blobs/prepare
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/blobs/:sha256/multipart/parts
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/blobs/:sha256/multipart/complete
POST /v1/workspace-replicas/:replicaId/snapshots/:snapshotId/commit
GET  /v1/workspace-replicas/:replicaId/sync-plans/:cycleId
POST /v1/workspace-replicas/:replicaId/sync-plans/:cycleId/downloads/prepare
POST /v1/workspace-replicas/:replicaId/sync-plans/:cycleId/applied
POST /v1/workspace-replicas/:replicaId/sync-plans/:cycleId/failed
```

Prepare accepts only the manifest descriptor and creates an upload session; the manifest is uploaded first through a signed URL. `manifest-ready` verifies manifest object metadata and schedules bounded worker parsing. Missing blob descriptors are returned/prepared in pages of at most 1,000 hashes, or fetched from the verified manifest, so no request contains a multi-million-entry blob inventory. Blob prepare is idempotent by `(snapshotId, sha256)`. Commit verifies signed object identity/transport metadata and creates the durable `uploaded` row. Worker verification advances it to `ready`; clients retain transfer state until that semantic ACK.

### 9.3 Lease

```text
POST /v1/spaces/:spaceId/workspace-lease/acquire
POST /v1/spaces/:spaceId/workspace-lease/renew
POST /v1/spaces/:spaceId/workspace-lease/release
```

All responses include epoch, base canonical snapshot, expiry, and canonical generation. Release with a stale epoch is a no-op plus an explicit stale response.

### 9.4 Native ingest

```text
POST /v1/workspace-replicas/:replicaId/native-ingests/inline
POST /v1/workspace-replicas/:replicaId/native-ingests/prepare
POST /v1/workspace-replicas/:replicaId/native-ingests/:ingestId/multipart/parts
POST /v1/workspace-replicas/:replicaId/native-ingests/:ingestId/multipart/complete
POST /v1/workspace-replicas/:replicaId/native-ingests/:ingestId/commit
GET  /v1/workspace-replicas/:replicaId/native-ingests/:ingestId
```

Canonical lifecycle-only batches up to 128 KiB use `/inline`: API validates the versioned envelope, policy version, event hash, and idempotency key and stores the JSONB as `committed` in one transaction, which keeps prompt visibility fast. Larger/final/history bundles use prepare plus signed object upload. Their commit verifies object identity/transport metadata, inserts or updates the durable `uploaded` row, and ACKs that upload; Agent worker canonical/schema verification advances it to `committed`. `applied` ACK arrives through polling/SSE after transcript projection and the visibility marker finish. Local spool retention follows the semantic ACK, not the upload ACK.

### 9.5 Conflict resolution

```text
GET  /v1/spaces/:spaceId/workspace-conflicts
POST /v1/spaces/:spaceId/workspace-conflicts/:conflictId/resolve
```

Resolution accepts `local`, `cloud`, `delete`, `keep_managed`, `unmanage`, or a separately uploaded merged blob with a required SHA-256. Resolution creates a new snapshot/cycle; it never mutates the conflicting snapshot. `unmanage` leaves bytes in place and records that future replication ignores the path until policy changes again.

### 9.6 Wire shapes, idempotency, and errors

All request bodies use protocol-versioned JSON. Mutation requests carry an `Idempotency-Key` whose scope is the authenticated device plus endpoint; the server also enforces the domain-specific unique keys in the database. Every response includes `requestId`, `protocolVersion`, and a stable resource/cycle/ingest ID where applicable.

```ts
interface SnapshotPrepareRequestV1 {
  version: 1;
  replicaId: string;
  snapshotId: string;
  replicaGeneration: number;
  parentSnapshotId: string | null;
  baseCanonicalSnapshotId: string | null;
  workspacePolicyVersion: number;
  executionAttemptId: string | null;
  manifest: {
    canonicalSha256: string;
    transportSha256: string;
    transportBytes: number;
    uncompressedBytes: number;
    fileCount: number;
    totalBytes: number;
  };
  blobInventory: {
    mode: "manifest_references" | "paged_descriptors";
    pageCount?: number;
    descriptorPageSha256?: string;
  };
}

interface SnapshotPrepareResponseV1 {
  version: 1;
  snapshotId: string;
  uploadSessionId: string;
  manifestUpload: SinglePutUploadV1;
}

type SinglePutUploadV1 = {
  mode: "single";
  objectKind: "manifest" | "blob" | "native_bundle";
  canonicalSha256: string;
  transportSha256: string;
  url: string;
  expiresAt: string;
  requiredBytes: number;
  uncompressedBytes?: number;
};

type MultipartUploadV1 = {
  mode: "multipart";
  objectKind: "blob" | "native_bundle";
  canonicalSha256: string;
  transportSha256: string;
  uploadId: string;
  partSize: number;
  totalBytes: number;
  uncompressedBytes?: number;
  partsCursor: string | null;
  expiresAt: string;
};

interface SnapshotManifestReadyResponseV1 {
  version: 1;
  snapshotId: string;
  verificationStatus: "pending" | "rejected";
  blobPageCursor: string | null;
  missingBlobCount: number | null;
}

interface SnapshotBlobPrepareRequestV1 {
  version: 1;
  cursor: string | null;
  descriptors: Array<{ sha256: string; size: number; mimeType: string | null }>;
}

interface SnapshotBlobPrepareResponseV1 {
  version: 1;
  cursor: string | null;
  nextCursor: string | null;
  existingBlobHashes: string[];
  uploads: Array<SinglePutUploadV1 | MultipartUploadV1>;
}

interface MultipartPartsResponseV1 {
  version: 1;
  objectKind: "blob" | "native_bundle";
  canonicalSha256: string;
  transportSha256: string;
  uploadId: string;
  partsCursor: string | null;
  nextPartsCursor: string | null;
  parts: Array<{
    number: number;
    url: string;
    bytes: number;
    checksum: string;
    expiresAt: string;
  }>;
}

interface MultipartCompleteRequestV1 {
  version: 1;
  uploadId: string;
  parts: Array<{ number: number; etag: string; checksum: string }>;
  canonicalSha256: string;
  transportSha256: string;
  totalBytes: number;
}

interface NativeIngestCommitResponseV1 {
  version: 1;
  ingestId: string;
  uploadStatus: "committed" | "uploaded";
  semanticStatus: "pending_verification" | "ready" | "applied" | "quarantined";
  executionAttemptId: string;
  cohubSessionId: string | null;
  cohubTurnId: string | null;
  nextPollAt: string | null;
}
```

The server never returns a signed URL for an object not named in the corresponding prepare row. Object keys are generated server-side. Error responses use stable codes and actionable state, without echoing absolute local paths or raw provider payloads:

| HTTP  | Code                                 | Meaning                                                                |
| ----- | ------------------------------------ | ---------------------------------------------------------------------- |
| `409` | `base_snapshot_stale`                | Re-scan/reconcile from the returned canonical snapshot                 |
| `409` | `writer_lease_held`                  | Wait/release/handoff; includes holder kind and retry time, not secrets |
| `409` | `native_cursor_stale`                | Automatic fork or explicit reconcile is required                       |
| `409` | `identity_collision`                 | Detach/rebind the native session or device                             |
| `409` | `case_collision`                     | Resolve paths for the target filesystem                                |
| `422` | `schema_unsupported`                 | Upgrade locald/provider or use hook reconstruction                     |
| `422` | `object_checksum_mismatch`           | Discard the transfer and retry from the immutable source               |
| `422` | `workspace_busy`                     | Wait for a stable scan                                                 |
| `429` | `quota_exceeded`                     | Reduce/resolve the reported quota dimension                            |
| `403` | `device_revoked` / `space_forbidden` | Re-pair or restore Space membership                                    |
| `503` | `sync_unavailable`                   | Keep the local spool and retry; no semantic ACK was issued             |

A `409`/`422` response is durable state, not permission to retry the same bytes blindly. The daemon records it and follows the prescribed transition.

## 10. Reliability and Storage

### 10.1 Local spool

Spool layout is private to the user:

```text
~/.local/share/cohub/locald/
  state.db
  spool/hooks/<eventId>.json
  spool/turns/<bundleId>.jsonl.gz
  spool/manifests/<snapshotId>.json.gz
  apply/<cycleId>/journal.json
```

Rules:

- Write temp file, fsync, atomic rename, then acknowledge the hook process.
- Keep a native turn bundle and state row until server `applied` ACK is committed locally. A failed/quarantined bundle remains until successful retry or explicit user export/discard.
- Workspace manifests/blobs may leave the transfer spool after the server verifies and commits the immutable candidate; a conflict ACK is sufficient because all three versions are then durably retained server-side.
- Recover orphan files by scanning spool directories at startup.
- Apply exponential backoff with jitter, but retry immediately on reconnect.
- Enforce a configurable disk budget with a preallocated owner-only emergency reserve for terminal event locators. At 80%, warn; when the reserve would be consumed, block a new strict-mode prompt rather than starting work whose terminal history cannot be spooled. Terminal hooks may consume the reserve. If a preflight spool write fails, return a blocking decision; if an observational hook write fails after the provider is already running, write the minimal provider/session/turn locator to the reserve and surface `reconcile_required`. If even the reserve is unavailable, never report a successful mirror ACK and raise a locald alert for manual recovery.
- Never log prompt, tool input/output, native IDs, tokens, or full local paths at info level.

### 10.2 Object storage

Use private S3-compatible storage with SSE-KMS in production:

```text
workspace-sync/spaces/<spaceId>/manifests/sha256/<prefix>/<hash>.json.gz
workspace-sync/spaces/<spaceId>/blobs/sha256/<prefix>/<hash>
workspace-sync/spaces/<spaceId>/plans/<cycleId>.json.gz
native-agent/spaces/<spaceId>/ingests/<ingestId>/<hash>.jsonl.gz
native-agent/spaces/<spaceId>/artifacts/sha256/<prefix>/<hash>
```

Content objects are immutable and deduplicated within one Space, not across tenants. Upload URLs are Space-, hash-, size-, replica-, and expiry-bound. Raw file blobs are verified by size and whole-file SHA-256; large files use resumable multipart transfer without changing their logical blob identity. Compressed structured objects are verified by transport checksum, decompression limits, canonical payload SHA-256, and declared uncompressed size. The prepare response never reveals whether the same hash exists in another Space.

Transfer descriptor rules are explicit:

- Objects below 16 MiB use one signed PUT with required byte count and SHA-256.
- Larger objects use an S3 multipart upload with a server-generated upload ID and 8 MiB part size (or the configured larger size). `parts` returns at most 100 signed part URLs per request; the client sends the next part cursor to the `multipart/parts` endpoint. Each URL is bound to object identity, part number, byte count, checksum, replica, and expiry.
- locald persists `{uploadId, nextPart, completedParts[{number, etag, checksum}]}` before each part and can resume after restart. It never treats a partial object as a blob.
- `multipart/complete` accepts only the recorded part numbers/ETags and expected whole-object checksum/size; the API records completion after object-store confirmation. Reusing an upload ID with a different object identity is rejected.
- Snapshot/native `commit` is allowed only after every required object is single-upload complete or multipart-complete; missing objects return `missing_object` and no semantic snapshot/ingest ACK is issued.

Retention:

- Canonical manifests: Space lifetime plus deletion retention.
- Non-canonical candidate manifests: 30 days after terminal cycle.
- Unreferenced blobs: mark-and-sweep after 30 days, never immediate refcount deletion.
- Sanitized native ingest bundles: 30 days after successful application, longer for quarantined/failed ingest. Raw native provider transcripts are never uploaded.
- Conflict objects: until conflict resolution plus 30 days, or Space deletion retention.

### 10.3 Queue durability

Add queues:

```text
cohub-workspace-sync
cohub-native-agent-ingest
```

Postgres rows are the durable work source. API performs best-effort enqueue with deterministic job IDs:

```text
workspace-sync-<cycleId>
native-agent-ingest-<ingestId>
```

A sweeper selects committed non-terminal rows using `FOR UPDATE SKIP LOCKED` and re-enqueues missing/stale jobs. A separate outbox dispatcher/sweeper publishes `session_realtime_outbox` rows. Workers are idempotent at every state transition. BullMQ retries improve latency but are not the only recovery mechanism.

### 10.4 Ordering

- Replica snapshots use per-replica monotonic generation.
- Canonical snapshots use per-Space monotonic generation.
- Hook events use per-native-session monotonic local sequence.
- Native turn bundles include previous and next provider cursor.
- CoHub transcript append uses a leaf/hash precondition.
- Workspace promotion uses base snapshot plus lease epoch preconditions.

Out-of-order input is retained but not applied until its predecessor is applied or declared missing/interrupted. Duplicate input returns the existing state.

Local device sequence counters and `binding_generation` are persisted before ACK. A device restart may create a gap, which is recorded as a diagnostic; it cannot reuse a prior `(binding, event_id)` with different bytes or move a binding cursor backward.

## 11. Security Boundaries

Device enrollment uses an OAuth/device-code or loopback browser flow initiated by `cohub workspace attach`; access tokens and refresh credentials are never accepted as command-line arguments. The API returns the refresh credential once over the authenticated pairing flow, and locald stores it in the OS keychain. Headless environments use a short-lived one-time pairing code displayed by the authenticated Web UI, never a permanent token pasted into shell history.

- Locald authenticates with a revocable device credential stored in the OS keychain. File fallback requires owner-only permissions and an explicit warning.
- Every server operation checks device owner, replica, Space, current Space membership, and session view/edit permission for any bound/forked session. Revoked membership blocks new ingest/apply immediately but preserves local spool for export/retry after access is restored.
- Device tokens cannot access Postgres, Redis, worker endpoints, session PVCs, or arbitrary object keys.
- Presigned URLs are short-lived and restricted to one object identity and size.
- Native provider credentials remain in provider homes and never enter manifests or hook payloads.
- Raw native session IDs and absolute paths are HMACed/redacted locally with domain-separated, versioned device keys and Space/replica scope for upload; device revoke invalidates those bindings.
- Local IPC uses owner-only Unix socket permissions or a user-scoped Windows named-pipe ACL.
- Hook input is size-limited and schema-validated before spooling.
- Workspace paths and provider `relativeCwd` are validated both at API planning and target apply/execution. Extra provider directories never expand a replica's authorization root.
- Symlinks are never followed during scan or apply.
- Conflict/blob downloads require Space membership and never expose raw object keys to Web clients.
- Provider hook output is empty on success. CoHub does not add model context or modify permission decisions, except the explicit strict-mode prompt block when workspace execution is unsafe.
- Session content imported from native tools is treated as untrusted content, not as CoHub control data.
- Audit events cover device enrollment/revocation, attach/detach, lease acquire/release/expiry, snapshot promotion, conflict resolution, native binding creation, and automatic fork.

## 12. Web, SDK, CLI, and Realtime

### 12.1 Web and mobile

The first release does not add a local/cloud execution selector. Web always executes in cloud.

Add only required operational UI:

- Space status indicator: `Synced`, `Local changes syncing`, `Cloud changes pending locally`, `Conflict`, `Device offline`, or `Offline reservation active`.
- Space local-agent policy surface: workspace replication mode, session mirror consent (`full`, `metadata only`, `disabled`), attachment scope, offline setting, policy version, and last device.
- Conflict resolution view with base/local/cloud metadata and text diff where available.
- Local turn provenance in existing turn details: provider, device, fidelity, completeness, and workspace snapshot.
- Existing fork UI displays automatic native divergence forks.
- When cloud execution is gated, keep the submitted turn queued and show `Waiting for workspace sync` or `Resolve workspace conflict` from turn metadata.
- Web cannot stop an unwrapped native process. The stop control is disabled for a running `native_agent` turn with concise copy. A cloud turn should not start when a local writer lease or unexpired offline reservation is active; Web takeover is an explicit workspace boundary and never a silent lease expiration.

All additions must work on desktop and mobile without changing the normal cloud Composer path.

### 12.2 Realtime

Reuse current session events for mirrored turns:

- `session.turn.created`
- `session.message.persisted`
- `session.turn.updated`
- `session.turn.finalized`

Extend `RealtimeDomain` additively with `workspace`; keep existing `system/session/space` domains unchanged. Add a workspace domain with coarse state events, not file-content events:

```text
workspace.replica.updated
workspace.sync.started
workspace.sync.completed
workspace.sync.conflicted
workspace.lease.updated
```

Payloads contain IDs, generations, state, active attempt/lease summaries, stats, and conflict counts. File bytes move only through object storage. Native ingest continues to use existing session event names; policy/consent changes never emit transcript content.

### 12.3 SDK

Add typed APIs for:

- Replica attach/status/detach.
- Snapshot prepare/commit and apply ACK.
- Lease acquire/renew/release.
- Native ingest inline/prepare/commit/status.
- Local-agent policy read/update and explicit pre-existing-session bind/import choice.
- Conflict list/resolve.

Public boundaries use explicit protocol v1 types. Do not expose provider raw transcript schemas as stable SDK types.

### 12.4 CLI

Commands:

```text
cohub workspace attach <space> --root <dir>
cohub workspace detach [--keep-local]
cohub workspace status [--json]
cohub workspace sync [--wait]
cohub workspace handoff local|cloud [--wait]
cohub workspace conflicts list
cohub workspace conflicts resolve <path> --local|--cloud|--delete|--file <path>
cohub workspace offline enable|disable [--max-duration <duration>]
cohub workspace daemon start|stop|logs

cohub agent hooks install pi|claude|codex
cohub agent hooks uninstall pi|claude|codex
cohub agent hooks doctor [provider]
cohub agent session bind --provider <provider> --import-history|--start-at-next-prompt
cohub agent policy get|set --session-mirror full|metadata_only|disabled
```

Installation writes only provider-supported user-scoped files: `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.pi/agent/extensions/cohub-local-agent.ts`. It does not edit Claude/Codex TOML or project-local settings. JSON files are parsed with strict schema validation, unrelated keys are preserved, a mode-0600 backup is written before mutation, and uninstall removes only the exact CoHub-owned object/extension. Hook definitions invoke an absolute, stable per-user launcher path rather than relying on `PATH` or a versioned CLI cache path; locald upgrades replace the launcher target atomically without rewriting hook definitions. Windows definitions use the provider's platform-specific command field.

## 13. Code Ownership and File Plan

### 13.1 Shared protocol

Add:

```text
packages/protocol/src/workspace-replication/
packages/protocol/src/local-agent/
packages/core/src/workspace-replication/
packages/infra/src/workspace-sync-queue/
packages/infra/src/native-agent-queue/
packages/infra/src/object-storage/

Pinned shared dependencies: `json-canonicalize` for RFC 8785 and `node-diff3` for bounded clean text merges.
```

Move checkpoint scan primitives and canonical path rules into shared core modules used by checkpoint, pending diff, and workspace sync. Make ignore behavior an explicit policy input: checkpoint retains current `.gitignore` semantics, while replication uses platform rules plus `.cohubignore`. Keep filesystem-specific scanning in worker/locald implementations and verify both against common golden fixtures.

### 13.2 Local daemon and CLI

Add:

```text
apps/sandbox/cmd/locald/
apps/sandbox/locald/{daemon,hook,spool,state,scan,apply,transfer,control}/
packages/cli/src/commands/workspace.ts
packages/cli/src/commands/locald-binary.ts
packages/cli/src/commands/agent-hooks.ts
packages/cli/src/provider-config-editors/{claude,codex,pi}.ts
```

Reuse the current sandboxd CDN binary release mechanism with an independently pinned `LOCALD_VERSION` and checksum verification.

### 13.3 API

Add:

```text
apps/api/src/routes/local-devices.route.ts
apps/api/src/routes/workspace-replicas.route.ts
apps/api/src/routes/workspace-sync.route.ts
apps/api/src/routes/native-agent-ingest.route.ts
apps/api/src/workspace-replication/
apps/api/src/native-agent-ingest/
```

Integrate `WorkspaceWriteCoordinator` into existing mutation paths:

```text
apps/api/src/space-fs-remote.ts
apps/api/src/space-sandbox-rpc.ts
apps/agent/src/processor.ts
apps/agent/src/run-command.ts
apps/gateway/src/relay/index.ts
packages/protocol/src/sandbox/
apps/sandbox/rpc/dispatcher.go
apps/sandbox/process/
```

Extend sandbox RPC/process-start payloads with an optional server-issued `{ executionAttemptId, leaseEpoch, writeCapability }` for controlled cloud writes. The sandbox validates the capability against the latest coordinator state available through its authenticated control/report channel; it rejects stale/missing capabilities for CoHub-mediated mutation calls. The capability is never exposed to local native providers or copied into user tool output.

### 13.4 Worker

Add:

```text
apps/worker/src/workspace-replication/scan.ts
apps/worker/src/workspace-replication/reconcile.ts
apps/worker/src/workspace-replication/apply.ts
apps/worker/src/workspace-replication/git.ts
apps/worker/src/workspace-replication/processor.ts
apps/worker/src/workspace-replication/sweeper.ts
```

Refactor reusable scanner/hash/filter and Git bundle behavior from:

```text
apps/worker/src/checkpoint/scan.ts
apps/worker/src/checkpoint/git-bundles.ts
apps/worker/src/checkpoint/materialize.ts
```

Checkpoint behavior must remain unchanged under its existing tests.

### 13.5 Agent

Add:

```text
apps/agent/src/transcript/reader.ts
apps/agent/src/transcript/committer.ts
apps/agent/src/transcript/cursor.ts
apps/agent/src/native-ingest/processor.ts
apps/agent/src/native-ingest/providers/pi.ts
apps/agent/src/native-ingest/providers/claude-code.ts
apps/agent/src/native-ingest/providers/codex.ts
apps/agent/src/native-ingest/sweeper.ts
```

Update `apps/agent/src/runtime/workspace-scope.ts` and session runtime construction to distinguish immutable authorization root from validated per-turn execution cwd.

Refactor, rather than duplicate, the relevant behavior in:

```text
apps/agent/src/runtime/local-session-manager.ts
apps/agent/src/persistence.ts
apps/agent/src/session.ts
apps/agent/src/fork.ts
apps/api/src/session-forks.ts
```

Extract the DB fork service to a shared core service that accepts a DB transaction boundary. Keep JSONL branch provisioning in `apps/agent`.

## 14. Implementation Sequence

The program can be approved once and implemented through reviewable milestones. Each milestone has a hard exit gate.

### Milestone 0: Protocol and writer foundations

1. Add protocol v1 types, execution-attempt correlation, canonical JSON/hash fixtures, and provider sanitization fixtures.
2. Add DB migrations and Drizzle schema, including workspace/integration policies, execution attempts, transcript state, event receipts, and realtime outbox.
3. Extract checkpoint scan policy and Git bundle records without behavior changes.
4. Extract `CohubTranscriptReader`, visibility-marker/cursor calculation, sidecar rebuild, and transaction-aware committer primitives.
5. Add Postgres-fenced workspace/session writer coordination and sandbox execution-attempt capability fields behind disabled enforcement.
6. Add queue definitions, execution gates, outbox dispatcher, and durable sweepers behind disabled feature flags.

Exit gate:

- Existing Agent and checkpoint tests pass unchanged.
- Existing cloud session JSONL output is byte/semantically equivalent; native commit markers and sidecar state do not alter legacy/cloud model context or product projection.
- Property tests prove deterministic manifest and cursor hashes.

### Milestone 1: Cloud snapshot service and locald skeleton

1. Build Space workspace policy, cloud scanner, snapshot rows, single/multipart object transfer, and canonical bootstrap.
2. Build locald device enrollment, keychain/identity state, service lifecycle, SQLite state, watcher, bounded scanner, and spool.
3. Implement attach/consent for an empty local root and one-way cloud-to-local materialization, including sensitive-content and nested-root boundaries.
4. Add status/policy CLI and metrics.

Exit gate:

- An existing cloud Space materializes identically on Linux and macOS local replicas.
- Kill/restart during download/apply recovers without partial visible state or data loss.
- Hash verification catches corruption.

### Milestone 2: Bidirectional workspace reconciliation

1. Implement local snapshot upload and content-addressed blobs.
2. Implement three-way planner, safe cloud/local apply, deletion guard, and conflict records.
3. Add execution attempts, online leases/offline reservations, and sandbox attempt capabilities to all current cloud mutation paths.
4. Add Git bundle state and fast-forward/conflict rules.
5. Add conflict CLI and minimal Web resolution UI.
6. Trigger cloud scans from sandbox `fs.changed` with periodic correctness scans.

Exit gate:

- Local changes reach cloud sandbox and Web.
- Cloud Agent/file changes reach local.
- Intentional offline work blocks cloud writers through a bounded reservation; stale/unreserved offline edits reconcile and non-overlapping edits merge.
- Content, delete/modify, type, case, and Git-ref conflicts preserve all versions and block execution.

### Milestone 3: Native ingest core and Pi

1. Add native ingest inline/prepare/multipart/commit API, consent policy enforcement, object storage, rows, queue, and sweeper.
2. Implement local hook IPC, execution-attempt correlation, sanitized durable turn bundling, and event receipts.
3. Add `native_agent` turn support through protocol/SDK/Web rendering and cloud claim gates.
4. Implement transcript hidden-entry/commit-marker visibility, sidecar repair, transactional DB projection, and shared realtime outbox.
5. Implement Pi extension and exact adapter.
6. Reuse automatic fork path with deterministic provisioning and current-canonical workspace reconciliation.

Exit gate:

- A native Pi turn containing tool calls/results appears in committed CoHub JSONL context, DB, and Web exactly once; hidden pre-marker entries never reach cloud context.
- Cloud `apps/agent` continues that session successfully.
- A later old-native continuation creates the correct fork.
- Network loss, duplicate upload, API crash, Agent crash, and locald crash recover without duplicate or lost turns.

### Milestone 4: Claude Code

1. Install/uninstall/doctor user-scoped hooks.
2. Implement event collector, delayed transcript reconciliation, versioned parser fixtures, and reduced hook reconstruction.
3. Handle StopFailure, compaction, attachments, and subagent metadata.
4. Run real-provider end-to-end compatibility tests for the supported version range.

Exit gate:

- Tool rounds are history-reconciled where supported.
- A lagging transcript still produces the correct final text from Stop.
- Unsupported transcript format degrades to explicit `hook_reconstructed`, not a failed or falsely exact import.

### Milestone 5: Codex

1. Install/uninstall/doctor user-scoped hooks and trust guidance.
2. Implement concurrent hook ordering and versioned optional history parser.
3. Handle compaction, SessionEnd interruption, attachments, and subagent metadata.
4. Run real-provider compatibility tests.

Exit gate:

- Normal Codex turns mirror and continue in cloud.
- Hook trust disabled/missing is diagnosed before relying on the integration.
- Transcript schema change disables only the parser and retains hook-reconstructed turns.

### Milestone 6: Production rollout

1. Add dashboards, alerts, admin diagnostics, object GC, and retention jobs.
2. Add launchd, systemd user, and Windows user-service installers.
3. Run shadow scanning on internal Spaces.
4. Roll out Pi, then Claude, then Codex by provider feature flag.
5. Publish CLI/locald/provider adapter compatibility matrix and migration docs.

Exit gate: all acceptance scenarios and SLOs below pass in production canary.

## 15. Test Strategy

### 15.1 Deterministic unit and property tests

Workspace planner tests generate combinations of:

- add/add same and different bytes
- modify/modify
- delete/modify
- type changes and empty directories
- symlink changes
- nested directory deletion and nested replica boundaries
- rename-like equal hashes
- scan/sensitive policy changes and stale policy versions
- case, Unicode normalization, Windows reserved-name, and path-length collisions
- active local/cloud execution attempts, offline reservations, and explicit takeover boundaries

Properties:

- Reconciliation is deterministic.
- Applying a plan yields its declared tree hash.
- Reapplying is a no-op.
- No conflicting input version becomes unreachable.
- A failed/incomplete scan never produces deletions.

Transcript tests cover:

- Deterministic entry/marker/fork IDs, branch epoch, semantic hash chain, and sidecar rebuild.
- Exact replay idempotency and binding-generation stale replay rejection.
- Crash before/after native JSONL append, DB projection, commit marker, sidecar update, outbox publish, and ACK.
- Hidden/unmarked native entries excluded from context, fork copy, cursor, and Web projection.
- Duplicate/out-of-order hook events, event-receipt collision, final-before-prompt, and orphan lifecycle events.
- Tool call/result pairing and parallel tools.
- Consent modes, policy version changes, sanitization, and metadata-only non-projection.
- Compaction and provider transcript replacement.
- Native rewind and deterministic automatic fork provisioning.
- CoHub cloud advancement, running-parent gate, and automatic fork.
- Awaiting-recovery deadline and verified audited late recovery.

### 15.2 Golden provider fixtures

Version fixture directories contain local-only sanitized copies of real hook/transcript inputs, the expected collector output, and the expected server projection:

```text
fixtures/native-agent/pi/<version>/
fixtures/native-agent/claude-code/<version>/
fixtures/native-agent/codex/<version>/
```

Every collector or adapter change runs old fixtures. Fixtures assert that raw session IDs, absolute paths, system/developer content, and configured secret canaries are absent from collector output. A new provider version is unsupported until fixtures establish both local sanitization and server projection. Raw provider schemas remain internal.

### 15.3 Integration tests

Run against real Postgres, Redis, object storage, PVC-like filesystem, API, worker, and Agent services:

- Inline/single/multipart prepare/upload/part-resume/complete/commit/semantic ACK with repeated requests and expired part URLs.
- Queue loss followed by DB sweeper recovery.
- Worker death at every state transition and execution-attempt barrier permutation.
- Session lock expiry, held physical lock takeover rejection, stale epoch, marker-chain, and sidecar repair.
- Workspace lease/reservation expiry, explicit takeover, sandbox write-capability rejection, and stale candidate reconciliation.
- Automatic fork DB plus JSONL working-file/atomic provisioning and idempotent retry.
- Existing realtime events and session list/title/label projection through ordered outbox delivery.

### 15.4 Cross-platform locald tests

CI and release smoke tests on Linux, macOS, and Windows where supported:

- Watcher overflow, permission/read/hash errors, and unstable trees followed by full-scan recovery without deletion.
- Atomic replace and file-lock behavior.
- Executable bit behavior.
- Symlink capability differences.
- Case-insensitive collisions.
- Unicode normalization.
- Long paths and Windows reserved names.
- Sleep/wake, clock changes, and network interface changes.
- Keychain and local socket ACLs.

### 15.5 Chaos and data-integrity tests

Inject:

- Locald kill during spool write, hash, upload, and apply.
- API kill after object upload and before/after DB commit.
- Worker kill during cloud apply.
- Agent kill after JSONL append and before DB projection.
- Redis flush or unavailable BullMQ.
- S3 timeout, stale signed URL, corrupt bytes, and wrong metadata.
- PVC partial write and stale NFS visibility.
- Provider hard kill with no terminal hook, awaiting-recovery timeout, and later verified history recovery.
- Sandbox process escaping/disconnecting from a controlled attempt and handoff process-group cleanup.
- Policy version changes during scan/upload/apply and consent revocation during native upload.

Each test asserts reachable original bytes, deterministic recovery state, and no duplicate visible turn.

### 15.6 End-to-end acceptance scenarios

1. Attach a cloud Space to an empty local folder.
2. Edit locally and observe the exact bytes in the cloud sandbox and Web.
3. Edit in cloud and observe exact bytes locally.
4. Use a bounded offline reservation and verify cloud work is gated; explicitly take over, then reconcile non-overlapping stale edits.
5. Make conflicting edits and resolve without losing either version.
6. Run native Pi with multiple tool rounds; continue from Web in cloud.
7. Continue from Web, then resume old native Pi and observe a fork.
8. Repeat 6-7 for Claude Code and Codex at their declared fidelity.
9. Disconnect during a turn, reconnect, and receive one turn and one workspace result.
10. Upload the same bundle repeatedly and receive the same IDs.
11. Kill every process at a write boundary and recover.
12. Revoke the device and verify transfer/ingest stops while local data remains intact.
13. Kill Agent after native JSONL append but before DB/marker, then verify Web/cloud cannot observe the hidden batch and repair completes exactly once.
14. Change Space sensitive-content policy and session consent independently; verify canonical workspace policy is shared across replicas and metadata-only creates no product session.
15. Resume multipart upload and local apply after restart; verify whole-file hash, no partial visibility, and exact tree hash.

## 16. Observability and SLOs

Metrics:

- Hook local IPC/spool latency, preflight blocks, reserve usage, and failures.
- Spool bytes, oldest unacknowledged event, and disk budget.
- Replica online state, watcher lag, scan duration, hash cache hit rate.
- Snapshot bytes/files, dedupe ratio, upload/download latency.
- Canonical generation/apply lag per replica, policy version lag, active execution-attempt age, and offline reservation age.
- Reconcile operation/conflict counts by type.
- Lease acquisition wait, expiry, stale epoch rejection.
- Native ingest age by state, adapter fidelity, completeness, retry/quarantine counts, and event-receipt collision counts.
- Session realtime outbox age, attempts, per-session ordering lag, and duplicate-envelope count.
- JSONL/DB/commit-marker/sidecar reconciliation repairs and hidden native entry count.
- Queue age and DB sweeper re-enqueues.
- Object verification and GC counts.

Initial SLO targets for healthy online devices and ordinary source trees:

- Hook process p99 local completion under 100 ms; no network dependency.
- First local turn state visible in Web within 2 seconds of API connectivity.
- Final mirrored turn visible within 5 seconds of Stop for a bundle under 10 MiB.
- A 1,000-file, 10 MiB delta canonicalized in under 10 seconds p95 on a warm scanner.
- Cloud-to-connected-local notification under 2 seconds p95, with polling recovery under 30 seconds.
- Zero silent conflict resolutions, remote applies into active cwd, hidden native batches visible to cloud context, unverified applies, or acknowledged-but-unrecoverable ingests.

Alerts page on oldest committed/publishing-marker ingest, hidden native entries, sidecar rebuild failures, canonical/cloud apply divergence, execution attempt or offline reservation beyond maximum, held physical lock without heartbeat, repeated hash mismatch, spool pressure, multipart orphan backlog, conflict backlog, and DB/JSONL cursor mismatch.

## 17. Deployment and Rollback

### 17.1 Server deployment

Add:

- DB migration before code rollout.
- API routes behind `WORKSPACE_REPLICATION_ENABLED` and `NATIVE_AGENT_MIRROR_ENABLED`.
- A workspace-sync worker profile/Deployment using the existing worker PVC mounts (`/space-storage` and `/system-storage`) and a least-privilege object-store role. It consumes only `cohub-workspace-sync`; it does not receive provider API keys.
- A native-ingest consumer in the Agent Deployment with session PVC access. Keep native-ingest concurrency separate from cloud turn concurrency so a large local bundle cannot starve Web execution.
- A durable session realtime-outbox dispatcher, colocated with Agent or as a small independently scalable consumer.
- API object-storage presign configuration scoped to the workspace/native-agent namespaces; the API does not receive arbitrary client object keys.
- Per-provider flags: `NATIVE_AGENT_PI_ENABLED`, `NATIVE_AGENT_CLAUDE_ENABLED`, `NATIVE_AGENT_CODEX_ENABLED`.
- Per-feature protocol/version flags and quotas in API/worker/Agent ConfigMaps; secrets remain in Kubernetes Secrets.
- S3 lifecycle rules only after DB mark-and-sweep is deployed.

Update these deployment/release surfaces together:

```text
apps/api package/config and routes
apps/agent package/config and deployment template/values
apps/worker queue entrance, deployment template/values, and PVC mounts
packages/cli locald binary resolver and hook installer
.github/workflows/sandbox-binaries-build.yml
```

The binary workflow should build/package `cohub-locald` as a distinct artifact and CDN namespace from `cohub-sandboxd`, with independent version/checksum pins. The CLI must verify the checksum before install and refuse a binary whose protocol range does not overlap the server. Include Linux/macOS/Windows targets only when their watcher/service/ACL test gates pass; do not advertise an untested platform.

No locald release should be advertised until all required server protocol versions are active.

### 17.2 Compatibility

API advertises a protocol range and schema capability set. Locald refuses a new attach when there is no overlap. For an already attached replica, incompatibility pauses upload/apply and leaves the local folder untouched; it does not call the replica filesystem read-only or try to prevent the user's editor/provider from writing. Local changes remain local candidates until upgrade. Provider adapters declare provider version ranges independently of locald protocol.

Cloud-only Spaces do not pay scanning cost until a replica is attached. Attaching bootstraps their initial canonical snapshot from the cloud PVC under the current `space_workspace_policies` version. Protocol downgrade is unsupported; rollback pauses replicas rather than writing an older manifest format.

### 17.3 Rollback

Server rollback procedure:

1. Disable new attach and native ingest prepare endpoints.
2. Stop issuing new workspace leases to local replicas.
3. Allow already committed ingests/cycles to drain or explicitly pause them in DB.
4. Keep the last canonical snapshot materialized in cloud.
5. Revoke or suspend device tokens if required.
6. Leave local folders, local spool, immutable objects, DB rows, and imported CoHub turns intact.

Never delete local state or accepted objects as part of feature rollback. Additive DB tables can remain until a later audited cleanup migration.

## 18. Explicit Non-Goals for v1

- Running a local provider from the Web browser.
- Remote control or abort of an unwrapped native provider process.
- Injecting CoHub prompt/context/tools into a local provider.
- Automatic CoHub-to-native provider history import.
- Byte synchronization of `~/.pi`, `~/.codex`, `~/.claude`, native transcripts, `.git`, sockets, or credentials.
- Simultaneous multi-writer editing with CRDT semantics.
- Automatic workspace branching per session fork; v1 keeps one canonical Space workspace and reconciles fork-attributed candidates against it.
- Token-level live mirroring. Turn-boundary mirroring is the correctness baseline.
- Perfect reconstruction of provider-private reasoning or unsupported native transcript fields.
- Support for legacy local-sandbox Spaces in the first replica release.

## 19. Delivery Risks

This is an XL cross-cutting feature, not a single-PR change. Approval should authorize one program delivered through the independently reversible milestones above.

| Risk                                                          | Why it matters                                                           | Required mitigation before release                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arbitrary local processes cannot be physically fenced         | A user/editor/provider can keep writing after a network lease expires    | Online permit/handoff, bounded offline reservations, immutable base snapshots, preconditioned apply, and three-way conflict preservation                                                                                               |
| JSONL and Postgres cannot commit atomically                   | A crash can expose only one representation                               | Immutable ingest journal, deterministic entry/message/marker IDs, hidden native-entry visibility barrier, session execution gate, sidecar repair, and tests at every boundary                                                          |
| Provider hooks can be absent, killed, reordered, or changed   | Missing/incorrect history would corrupt continuation semantics           | Local spool, lifecycle aggregation, stale recovery, paired collector/adapter fixtures, declared fidelity, and quarantine for unsupported versions                                                                                      |
| Codex/Claude native history formats can drift                 | A permissive parser can silently mis-map tools/messages                  | Hooks as the stable baseline, exact version ranges, golden fixtures, and parser disablement rather than optimistic parsing                                                                                                             |
| Shared cloud PVC has writers outside the new worker           | Sync apply can race Agent/API/command writes                             | Integrate every current mutation entry point with `WorkspaceWriteCoordinator`, pass attempt tokens through sandbox RPC/process registration, retain periodic unattributed scans, and reject stale preconditions                        |
| Git internals are not safely file-syncable                    | Copying `.git` can corrupt refs/index/object packs                       | Hard-exclude `.git`, use bundles/fetch namespaces, fast-forward only, and surface divergent refs                                                                                                                                       |
| Large trees and retained immutable data can grow cost quickly | Scanner, object storage, and transfer can become operational bottlenecks | Explicit quotas, hash cache, dedupe, backpressure, mark-and-sweep GC, and deletion recovery windows                                                                                                                                    |
| Cross-platform watcher/apply behavior differs                 | Case, Unicode, symlink, locking, and service behavior can lose parity    | Golden manifest fixtures plus Linux/macOS/Windows release and crash tests before declaring that platform supported                                                                                                                     |
| Mirrored sessions may contain sensitive local tool data       | Session export expands the cloud data boundary                           | Separate versioned session consent, metadata-only mode, local allowlist/credential sanitization, no raw transcript upload, private encrypted objects, scoped attachments, Space-scoped HMAC IDs, revocable device auth, and audit logs |

The release is blocked if any accepted ingest can become unrecoverable, hidden native entries can reach cloud context before their marker, remote apply can touch an active cwd, any conflict path can lose one side's bytes, an existing native session is silently backfilled without consent, or an adapter can claim `exact` without a versioned fixture proving it.

## 20. Approval Criteria

This plan is ready for implementation when the following product choices are accepted as a package:

1. Native session integration is a local-to-CoHub mirror, not native file synchronization.
2. Web continuation does not mutate native history; later native continuation forks.
3. Workspace online execution is single-writer coordinated; intentional offline work uses a bounded reservation and all other offline changes reconcile from a stale base.
4. `.git` uses object/ref-aware transfer rather than filesystem replication.
5. CoHub JSONL and Postgres remain server-owned and are repaired through an ingest journal.
6. Pi ships first as the exact-fidelity gate, followed by Claude and Codex with declared fidelity.
7. Conflicts, policy drift, incomplete scans, hidden transcript batches, and unsupported provider versions block or degrade explicitly; no silent fallback claims full synchronization.
8. Workspace attachment and native-session content mirroring have separate versioned consent; metadata-only mode creates no product transcript.
9. An execution attempt is the durable barrier joining workspace and transcript outcomes, and remote apply never mutates an active executor cwd.

Once accepted, Milestones 0-6 are the implementation order and their exit gates are the release criteria.
