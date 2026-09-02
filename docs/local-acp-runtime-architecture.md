# Local ACP Runtime Architecture

Status: implemented behind rollout flags; real deployment acceptance pending
Date: 2026-09-02

This document is the normative design for local provider execution. The older
native transcript hook plan remains available only as a legacy compatibility
path and must not be enabled as the default ACP execution path.

## Decision

Cohub uses an ACP-only control plane for local provider sessions:

```text
Web/mobile -> Cohub API -> Agent worker -> Gateway runtime peer
                                           ^
                                           |
                                  locald -> official ACP adapter
                                           |
                                  native provider process
                                           |
                                  local materialized replica
```

The provider keeps its own tools, model selection, configuration, credentials,
plugins, native session files, and native journal. Cohub receives ACP
`session/update` events and projects them into the product transcript, DB,
JSONL, Redis stream, and realtime envelopes. The provider is not aware of
Cohub's transcript projection.

Cohub does not register or broker MCP servers. It does not implement an MCP
server, MCP bridge, MCP-over-ACP path, or custom MCP workspace tools. An MCP
server configured by a provider is outside Cohub's protocol and permission
model. The local bridge forwards an empty `mcpServers` list required by ACP;
it never registers or brokers a server and strips any supplied entries.

ACP transcript projection requires explicit `full` session-mirror consent for
the device and Space. `metadata_only` and `disabled` remain valid choices for
workspace replication and legacy hook ingest, but they cannot register or run
an ACP runtime that would receive portable transcript content.

## Glossary

- **Runtime**: a registered local ACP host identified by `runtimeId`, device,
  provider, and workspace replica.
- **ACP adapter**: an official provider adapter or provider-maintained bridge
  that speaks ACP over stdio and translates the provider's native API/events.
- **Local replica**: a real local directory materialized from a canonical cloud
  snapshot. It is an execution copy, not a second source of truth.
- **Cloud replica**: the canonical cloud workspace mounted for cloud execution.
- **CoHub session**: the product transcript and server-owned session history.
- **ACP session**: the provider session identifier owned by the local adapter.
- **Execution attempt**: the fenced association of one CoHub turn with one
  runtime, replica, base snapshot, and workspace lease.
- **Candidate snapshot**: a locally observed tree awaiting server reconcile.
- **Canonical snapshot**: the server-approved workspace tree from which an
  execution may start.
- **Command ledger**: durable record of an outbound ACP prompt and its known
  outcome.
- **Event receipt**: durable, ordered, content-hashed record of an inbound ACP
  notification.

## Ownership

| Concern | Owner |
| --- | --- |
| Provider tools and native configuration | Provider and local adapter |
| Provider credentials and native session files | User machine/provider |
| Local working tree during a turn | Provider process, fenced by Cohub lease |
| Canonical workspace snapshot | Cohub API and workspace worker |
| CoHub transcript JSONL and Postgres projection | Agent worker |
| ACP command/event ordering and dedupe | Agent worker and runtime tables |
| Relay authentication and NAT traversal | Gateway |
| Local durable spool, apply journal, and token storage | locald |
| User-facing runtime selection | Web/SDK/CLI |

No Cohub custom tool may operate on the cloud directory while a provider native
tool operates on the local directory. The provider process and all native file,
process, shell, and git tools run with the same local replica as their ACP
adapter.

## Runtime Lifecycle

1. The CLI enrolls a device and attaches a local workspace replica.
2. The CLI registers a runtime for the device, Space, replica, and provider.
3. locald starts an outbound Gateway control connection using the device token.
4. Gateway authorizes the runtime against the device credential version and
   advances its connection epoch. A newer connection fences the older one.
5. A Cohub Agent worker opens a short-lived runtime peer data channel when it
   has a local ACP execution attempt.
6. locald starts the official ACP adapter with the local replica as its working
   directory and forwards newline-delimited JSON-RPC.
7. The Agent negotiates `initialize`, then uses `session/new`, `session/load`,
   or `session/resume` as supported by the adapter. If an existing session has
   durable events but cannot be loaded or resumed, execution fails explicitly
   with `runtime_reconnect_required`.
8. The Agent sends one `session/prompt` bound to the execution attempt. A
   provider response and all ordered `session/update` notifications are
   projected to the CoHub session.
9. The adapter exits when the peer channel closes. Provider native session
   persistence remains in the provider's normal home directory.

A runtime may have multiple ACP sessions over its lifetime, but one runtime
connection has one active provider channel at a time. Workspace leases remain
the authority for cross-process and cross-worker serialization.

## Prompt and Command Semantics

A local prompt is always immediate and cannot carry a Cohub model, provider,
thinking, generation-policy, or environment override. The provider's native
configuration remains authoritative.

A local prompt is accepted only when:

- the runtime belongs to the requesting user and Space;
- the runtime is `ready` or queueable `busy`;
- the local replica is ready and its applied snapshot equals the current
  canonical snapshot;
- the execution attempt records the runtime and exact replica;
- a fresh local writer lease is acquired before the provider process can run.

The Agent writes a command ledger row with a deterministic command id derived
from the execution attempt. The state machine is:

```text
prepared -> sent -> completed
                    \-> failed
sent     -> unknown (connection outcome cannot be established)
```

A `prepared` command may be sent. A `completed` command is replayed from its
stored response and receipts, without sending another provider prompt. A
`failed` command returns the recorded provider error. A `sent` or `unknown`
command is never blindly retried: the turn fails with
`runtime_reconnect_required`, because sending it again could execute the user's
request twice.

## Event Reducer

Each inbound ACP notification is canonicalized and SHA-256 hashed. The Agent
serializes receipt insertion per runtime session and assigns a monotonic server
sequence. A provider event id or provider sequence is used when available;
otherwise the connection epoch and ingress sequence provide an at-most-once
identity for that connection. Reusing an event id with a different payload is a
fatal integrity error and closes the ACP connection.

The reducer currently projects the standard portable updates:

- `agent_message_chunk` -> assistant text content;
- `agent_thought_chunk` -> thinking content;
- `tool_call` and `tool_call_update` -> tool use/result content;
- `usage_update` -> usage totals.

Unknown provider-specific updates remain durable receipts and are not guessed
into product content. This is intentional; unsupported formats are observable
without corrupting the transcript.

Live updates are full content snapshots with monotonic stream sequence numbers.
The final response is persisted through the existing idempotent message writer,
which finalizes `session_turns`, publishes realtime events, and updates the
server-owned JSONL. Replaying a completed command reuses the same deterministic
assistant message id and persistence idempotency key.

## Permission Requests

ACP `session/request_permission` is handled by the Agent client. A full-access
Cohub turn selects an allow option; a read-only turn selects a reject option.
The decision is scoped to the active turn and is never inferred from provider
configuration. Unsupported ACP client requests fail clearly instead of being
silently translated into a Cohub custom tool.

## Workspace Turn Boundary

Before `session/prompt`, the Agent locks `workspace_state`, verifies that the
canonical snapshot is unchanged, locks the exact local replica, verifies its
`appliedSnapshotId`, and acquires the `local_agent` writer lease. The lease has
an epoch and an expiry; heartbeats include the epoch and cannot revive an
expired lease.

During the turn, native provider tools mutate only the local replica. After the
ACP response, locald scans the same directory and uploads a candidate snapshot
with:

- the exact parent/applied snapshot;
- the execution attempt id;
- the lease epoch;
- the workspace policy version;
- JCS canonical manifest and SHA-256 content hashes.

The workspace worker performs three-way reconcile against the current cloud
snapshot. Non-overlapping changes converge. Divergent changes create an
explicit conflict and block promotion. Candidate, apply, and rollback journals
are durable locally and remotely; a failed upload never silently replaces a
newer canonical tree.

The workspace lease is not released until the candidate has been durably
prepared/committed or a recoverable finalization spool record has been written.
ACP permits are marked separately in local state so the ordinary daemon never
extends an ACP lease after the runtime process has crashed; the runtime process
renews its local permit while alive and the Agent owns the server lease heartbeat.
A runtime process runs the same retry loop as locald,
while SQLite spool records make finalization retryable after a crash or network
outage.

## Reconnect and Failure Semantics

- Control disconnect: Gateway marks the fenced epoch offline; pending peer
  channels close and the Agent preserves durable receipts.
- Data disconnect during a prompt: the command remains `sent`/`unknown`; the
  provider prompt is not replayed automatically.
- Provider crash: locald closes the channel, preserves a workspace-terminal
  finalization record, and lets the Agent mark the CoHub turn failed or
  interrupted.
- Agent crash after provider completion: the next worker can load the command
  ledger and replay receipts to finish transcript persistence.
- Session load/resume failure with prior events: return
  `runtime_reconnect_required`; never create a new ACP session that would hide
  the continuity break.
- Device revoke or consent/policy change: runtime rows are fenced/revoked or
  disconnected, active attempts are aborted, and leases expire immediately.
  Existing channels cannot authorize a new command with the revoked epoch.
- Workspace takeover: an expired local writer with an unresolved attempt
  requires explicit confirmation and records the takeover boundary.
- Unknown provider update: store the receipt, skip semantic projection, and do
  not guess its meaning.
- Cleanup failure: retain the original business error; cleanup errors are
  logged or spooled separately.

## Legacy Compatibility

The existing provider hook/native-ingest modules may remain behind their legacy
flag while ACP rollout is validated. They must not be enabled as the default
executor, and their records must not be mixed into an ACP command's reducer.
Legacy hooks may be removed after production ACP migration and retention checks
complete.

## Rollout Gates

Development rollout requires `LOCAL_ACP_RUNTIME_ENABLED` plus the provider
flag (`LOCAL_ACP_PI_ENABLED`, `LOCAL_ACP_CLAUDE_ENABLED`, or
`LOCAL_ACP_CODEX_ENABLED`). It also requires a real Postgres migration,
Redis/BullMQ queue, S3-compatible object storage, Gateway relay, locald binary,
and at least one official provider adapter. Unit typechecking is not a
substitute for these checks.

The minimum acceptance matrix is:

1. Pi ACP adapter: new session, prompt, streamed text/tool updates, cancel, and
   native file mutation in the attached local replica.
2. Gateway reconnect and token rotation with no data-channel authorization
   mismatch.
3. Agent restart after a completed provider prompt with command-ledger replay.
4. Provider crash with candidate snapshot finalization retry.
5. Stale canonical/local applied snapshot rejection before provider startup.
6. Two workers racing for one runtime/workspace, with one fenced out.
7. Conflicting local/cloud edits, rollback, and explicit resolution.
8. Device/runtime revoke fencing and no credential leakage to provider env.
9. Claude Code and Codex adapter capability negotiation after the Pi path is
   stable.
