# @neta-art/cohub-cli

CLI for [Cohub](https://cohub.run) — work with Spaces, Chats, files, Saves, Tasks, scheduled prompts, search, and multimodal generation from your terminal.

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

Pass nodes, effects, and sequences as JSON when creating a Board. The path and
title stay explicit in the command:

```bash
cohub -s <spaceId> boards create boards/plan.board \
  --title "Plan" \
  --input board-content.json
```

Transactions are JSON objects without `boardId`; the bound Board supplies it.
`txId` is generated when omitted, while `baseVersion` must be provided in the
input or with `--base-version`:

```json
{
  "baseVersion": 3,
  "operations": [
    {
      "type": "board.patch",
      "payload": { "patch": { "title": "Updated plan" } }
    }
  ]
}
```

```bash
cohub -s <spaceId> boards validate <boardId> --input transaction.json
cat transaction.json | cohub -s <spaceId> boards apply <boardId> --input - --json
cohub -s <spaceId> boards play <boardId> <sequenceId>
cohub -s <spaceId> boards seek <boardId> <playbackId> 400
cohub -s <spaceId> boards stop <boardId> <playbackId>
```

Pass `--tx-id` or `--command-id` when a script needs a stable idempotency key
across retries.

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
through `client.work.realtime` in the SDK rather than as CLI commands.

## Drive the Cohub UI

Show a Work preview in the Cohub tab that started the current work, and call
methods the Work exposes.

```bash
cohub ui preview <workId|url|cohub://works/...|username/space/work>
cohub ui preview <work> --call selection.get
cohub ui preview <work> --call board.focus --data '{"nodeId":"n1"}'
cohub ui preview <work> --call report.build --input payload.json --json
```

`ui preview` accepts the same Work references as `works get`. Showing a preview is
idempotent: repeating it re-activates the same tab and refreshes any launch state
carried by the reference. With `--call`, the command waits for the Work to announce readiness, invokes the method,
and waits for the Work to complete the same UI command with `client.ui.reportResult()`.

Work authors decide what is callable by registering handlers inside the Work:

```ts
client.work.surface.handle("image.open", async (input, { commandId }) => {
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
