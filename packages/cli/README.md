# @neta-art/cohub-cli

CLI for [Cohub](https://cohub.live) — work with Spaces, Chats, files, Saves, Tasks, scheduled prompts, search, and multimodal generation from your terminal.

## Installation

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Sign in

For normal use outside Cohub Sandbox, sign in once:

```bash
cohub auth login
cohub auth whoami
```

The CLI will keep you signed in and refresh your session automatically.

Inside Cohub Sandbox or CI, `COHUB_EXECUTION_TOKEN` can be used as an ephemeral auth override.

## Environment

The CLI uses production by default.

Use the development environment with `ENV=dev`:

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## Usage

Use `--json` when reading output for decisions, extracting IDs, or chaining commands.

For command details:

```bash
cohub -h
cohub spaces -h
cohub spaces prompt -h
```

## Terminology

| Product UI | CLI / API |
|---|---|
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule |
| Recurring scheduled prompt | Cron job |

## Spaces

```bash
cohub spaces ls --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
cohub spaces create --name "<name>" --description "<description>" --json
cohub spaces create --name "<name>" --checkpoint <checkpointId> --json
cohub spaces update <spaceId> --slug <space-slug>
cohub spaces rename <spaceId> "<new name>"
cohub -s <spaceId> spaces invites create --role builder --days 7
cohub -s <spaceId> spaces invites ls
cohub -s <spaceId> spaces invites revoke <code> --yes
cohub -s <spaceId> run -- git status
```

Many space-scoped commands need a target Space:

```bash
cohub -s <spaceId> spaces prompt "message" --json
COHUB_SPACE_ID=<spaceId> cohub spaces prompt "message" --json
```

## Local workspace replicas

Install the pinned, checksummed local runtime, attach a folder, then install only the provider integration you use:

```bash
cohub agent runtime install
cohub workspace attach <spaceId> ./project --merge --mirror full
cohub agent runtime register <spaceId> <replicaId> pi
cohub agent runtime start <spaceId> <replicaId> pi --root ./project
cohub agent doctor
```

`cohub agent doctor` reports the installed ACP adapter separately from the optional legacy hook integration. A non-empty folder requires exactly one initial strategy: `--merge`, `--use-cloud`, or `--use-local`. `--use-cloud` creates a verified local recovery backup before replacing managed content. Empty folders default to `--use-cloud`.

Prepare a bounded writer handoff before a legacy native-hook turn. ACP runtime prompts acquire their lease through the Agent worker:

```bash
cohub workspace handoff local --space <spaceId> --replica-id <replicaId> --wait
```

Intentional offline work requires a reservation. The command also writes a one-use permit into locald:

```bash
cohub workspace offline enable --space <spaceId> --replica-id <replicaId>
cohub workspace offline disable --space <spaceId> --device-id <deviceId> --epoch <epoch>
```

Inspect and resolve retained workspace conflicts without materializing conflict files into the project:

```bash
cohub workspace conflicts --space <spaceId>
cohub workspace resolve <conflictId> --space <spaceId> --use-local
```

`COHUB_LOCALD_BIN` overrides the runtime path for development. `COHUB_LOCALD_VERSION` and `COHUB_LOCALD_CDN_BASE_URL` select a released version and mirror. ACP runtime control uses locald and the Gateway relay; network transfer and retries happen in the daemon.

For ACP execution, install the official adapter for the provider separately so it can keep using its own configuration and credentials, then register and start a runtime:

```bash
npm install -g pi-acp
# Or install the adapter matching the selected provider:
# npm install -g @agentclientprotocol/codex-acp
# npm install -g @agentclientprotocol/claude-agent-acp
cohub agent runtime register <spaceId> <replicaId> pi
cohub agent runtime start <spaceId> <replicaId> pi --root ./project
cohub agent runtime list <spaceId>
cohub agent runtime get <spaceId> <runtimeId>
cohub agent runtime revoke <spaceId> <runtimeId>
```

The official adapter commands are `pi-acp`, `codex-acp`, and `claude-agent-acp`. Runtime prompts are selected in the Web composer or sent by SDK callers with `runtimeId`; they run immediately and do not accept a Cohub model override. Provider MCP configuration remains provider-owned and is not registered by Cohub.

## Chats and prompts

Use `spaces prompt` for immediate sends, delayed sends, one-time schedules, recurring schedules, new Chats, and existing Chats.
Use `run` for a one-off shell command in the current Space workspace.

```bash
# Send now
cohub -s <spaceId> spaces prompt "message" --json

# Send long content from stdin
cat prompt.md | cohub -s <spaceId> spaces prompt --json

# Send to an existing Chat
cohub -s <spaceId> spaces prompt --session <sessionId> "message" --json

# Send immediately through a registered local ACP runtime
cohub -s <spaceId> spaces prompt --runtime-id <runtimeId> "message" --json

# Create a new Chat and send
cohub -s <spaceId> spaces prompt --title "<chat title>" "message" --json

# Schedule once
cohub -s <spaceId> spaces prompt --at "2026-05-12T09:00:00+08:00" "message" --json

# Schedule recurring
cohub -s <spaceId> spaces prompt \
  --cron "0 9 * * 1-5" \
  --timezone "Asia/Shanghai" \
  --title "Daily reminder" \
  "message" \
  --json
```

Scheduling rules:

- Use only one of `--delay-ms`, `--at`, or `--cron`.
- `--cron` requires `--timezone`.

## Chats / Sessions

```bash
cohub -s <spaceId> spaces sessions ls --json
cohub -s <spaceId> spaces sessions create "<title>" --json
cohub -s <spaceId> spaces sessions get <sessionId> --json
cohub -s <spaceId> spaces sessions rename <sessionId> "<new title>"
```

Use `spaces prompt --session <sessionId>` to send to a Chat.

## Space turns

List recent turns across all visible Sessions in a Space:

```bash
cohub -s <spaceId> spaces turns ls
cohub -s <spaceId> spaces turns ls --author others --limit 50 --json
cohub -s <spaceId> spaces turns ls --session <sessionId>
```

Use `pageInfo.nextCursor` with `--cursor` to load older pages. Use a previous
`snapshotCursor` with `--after` and an explicit `--before` boundary to query
newer turns:

```bash
cohub -s <spaceId> spaces turns ls --cursor <nextCursor> --json
cohub -s <spaceId> spaces turns ls --after <snapshotCursor> --before <snapshotAt> --json
```

## Boards

Board commands use the selected Space and support `-h` at every level:

```bash
cohub boards -h
cohub boards inspect -h
cohub -s <spaceId> boards create boards/plan.board --title "Plan"
cohub -s <spaceId> boards inspect <boardId> --json
cohub -s <spaceId> boards capabilities <boardId>
cohub -s <spaceId> boards watch <boardId> --json
```

Pass semantic items, effects, and compositions as JSON when creating a Board. The path and title stay explicit in the command. Generate editable templates instead of guessing fields:

```bash
cohub boards examples create > board-content.json
cohub boards examples item geo > item.json
cohub boards examples effect pulse > effect.json
cohub boards examples composition fade > intro.json
```

Inspect `boards capabilities --json` for supported Item types, animation channels, effect kinds, and coordinate spaces.

```bash
cohub -s <spaceId> boards create boards/plan.board \
  --title "Plan" \
  --input board-content.json
```

Generate editable semantic JSON templates instead of authoring storage transactions:

```bash
cohub boards examples item text > item.json
cohub boards items create <boardId> --input item.json

cohub boards examples composition fade > intro.json
cohub boards compositions apply <boardId> --input intro.json

cohub boards examples effect pulse > effect.json
cohub boards effects apply <boardId> --input effect.json
```

Use `--mutation-id` or `--command-id` when a script needs a stable idempotency key across retries.

```bash
cohub -s <spaceId> boards play <boardId> <compositionId>
cohub -s <spaceId> boards seek <boardId> <playbackId> 400
cohub -s <spaceId> boards stop <boardId> <playbackId>
```

## Search

Search Spaces, Chats, and prior turns:

```bash
cohub search "query"
cohub search "query" --limit 20 --json
```

## Models and multimodal generation

```bash
cohub models ls --json
cohub models ls --model-type multimodal --json
cohub models show <model>
cohub models show <model> --json

cohub generate "a calm lake at sunrise" \
  --model <model> \
  --output output.png \
  --json

cohub generate "restyle this image" \
  --model <model> \
  --image ./input.png \
  --param size=1024x1024 \
  --json

cohub generate "smoothly transition from the first frame to the last frame" \
  --model seedance-2-0-fast \
  --image first_frame=https://example.com/first.png \
  --image last_frame=https://example.com/last.png

cohub generate "keep the character identity from all reference images" \
  --model seedance-2-0-fast \
  --image reference_image=https://example.com/reference-1.png \
  --image reference_image=https://example.com/reference-2.png

cohub generate "a calm lake" \
  --model <model> \
  --async

cohub tasks get <taskRunId> --json
```

Supported inputs:

```bash
--image <path-or-url>
--image first_frame=<path-or-url>
--image last_frame=<path-or-url>
--image reference_image=<path-or-url>
--video <path-or-url>
--video reference_video=<path-or-url>
--audio <path-or-url>
```

Role-qualified media values add `meta.role` to that content block. Repeat `--image reference_image=...` for multiple reference images. Seedance role-qualified media should use public URL inputs. Do not mix first/last frame roles with reference roles in one request.

Pass generation parameters with `--param key=value` or `--parameters '<json>'`.

## Files

```bash
cohub -s <spaceId> spaces files ls [path] --json
cohub -s <spaceId> spaces files cat <path>
cohub -s <spaceId> spaces files write <path> -c "<content>"
cohub -s <spaceId> spaces files upload <files...> --dir <dir>
cohub -s <spaceId> spaces files mv <from> <to>
cohub -s <spaceId> spaces files rm <path>
```

Confirm before deleting files or directories.

## Works

Publish and manage Work entries from a Space workspace. Public Work URLs require a username and a Space slug.

```bash
cohub profile update --username <username>
cohub spaces update <spaceId> --slug <space-slug>
cohub -s <spaceId> works ls --json
cohub works get <workId|url|username/space/work> --json
cohub works stats <workId|url|username/space/work>
cohub works download <workId|url|username/space/work> --output <path>
cohub -s <spaceId> works publish demo --file dist/index.html
cohub -s <spaceId> works publish site --dir dist
cohub -s <spaceId> works publish app --port 3000
cohub works publish-version <workId>
cohub works versions <workId> --json
cohub works rm <workId> --yes
```

Resolve a published Work by public identity:

```bash
cohub works resolve <workSlug> --owner <username> --space-slug <spaceSlug>
```

Use `--json` for machine-readable output. `works get`, `works stats`, and `works download` also accept `cohub://works/<username>/<space>/<work>` mention URIs. `works stats` reports total, 24-hour, 7-day, and 30-day views with a source breakdown. Download restores newly published file and directory artifacts directly from the CDN with checksum verification. HTML files with companion assets are restored as directory bundles; Board and port Works are not downloadable. The resolve command remains available for explicit slug-based lookup.

Realtime rooms use a published Work's runtime identity, so they are available
through `client.app.realtime` in the SDK rather than as CLI commands.

## Drive the Cohub UI

Show a file or Work preview in the Cohub tab that started the current work, and call
methods the Work exposes.

```bash
cohub desktop open <workId|url|cohub://works/...|username/space/work|file://path>
cohub desktop open file://src/main.ts
cohub desktop open work://alice/studio/launch
cohub desktop open <work-or-file> --call selection.get
cohub desktop open <work> --call board.focus --data '{"nodeId":"n1"}'
cohub desktop open <work> --call report.build --input payload.json --json
```

`ui preview` accepts `file://` Space-relative paths, `work://` Work references, and
legacy bare targets. A bare target checks the current Space for a file first, then
falls back to the same Work references as `works get`. Showing a preview is
idempotent: repeating it re-activates the same tab and refreshes any launch state
carried by the reference. With `--call`, the command waits for the Work to announce readiness, invokes the method,
and waits for the Work to complete the same UI command with `client.ui.reportResult()`.

Work authors decide what is callable by registering handlers inside the Work:

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});
```

A Work answers only a Cohub app origin, so a third-party site that embeds it
cannot invoke these methods.

Retrying with the same `--command-id` re-delivers the command rather than
returning a stale pending record, which recovers a dispatch that never reached the
browser. The frontend dedupes by command id, so ordinary redelivery does not run
twice.

Delivery is at-least-once. Deduplication lives in the receiving tab's memory, so a
retry that spans a page reload can run a `--call` method a second time. Prefer
methods that are safe to repeat.

Commands reach only the frontend instance that originated the current work,
resolved from request provenance (`X-Cohub-Source-Client`, propagated into the
Sandbox as `COHUB_SOURCE_CLIENT_ID`). They cannot target another user's browser,
and offer no DOM access or script evaluation. Pass `--client` to address a
specific instance of your own account, and `--command-id` to make retries safe.

## Saves

```bash
cohub -s <spaceId> spaces checkpoints ls --json
cohub -s <spaceId> spaces checkpoints get <checkpointId> --json
cohub -s <spaceId> spaces checkpoints create "<description>" --json
```

## Run commands

```bash
cohub -s <spaceId> run -- git status
cohub -s <spaceId> run --command "pnpm test"
cohub -s <spaceId> run --async --command "pnpm build"
```

Use `run` for one-off shell commands in a Space workspace. Use `--async` to queue and return immediately.

## Tasks

```bash
cohub tasks ls --space <spaceId> --json
cohub tasks get <taskRunId> --json
```

Create scheduled sends with `spaces prompt` scheduling flags, not task commands.

## Recurring scheduled prompts

Create recurring scheduled prompts with `spaces prompt --cron ... --timezone ...`.

Manage them with `cron-jobs`:

```bash
cohub cron-jobs ls <spaceId> --json
cohub cron-jobs runs <cronJobId> --json
cohub cron-jobs toggle <cronJobId> on
cohub cron-jobs toggle <cronJobId> off
cohub cron-jobs delete <cronJobId>
```

Confirm before enabling, disabling, or deleting recurring scheduled prompts.

## Safety

Confirm before:

- deleting files, directories, or Works
- creating scheduled or recurring prompts with side effects
- enabling, disabling, or deleting recurring scheduled prompts
- changing access policies, member roles, or membership
