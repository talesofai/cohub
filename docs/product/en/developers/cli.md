---
title: CLI
description: Install Cohub CLI, sign in, and run the main Space workflows from your terminal.
---

The Cohub CLI exposes the same product surface from a terminal: Spaces, Chats, files, Saves, Works, generation, and more.

Package: `@neta-art/cohub-cli`

## Install

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Sign in

```bash
cohub auth login
cohub auth whoami
```

The CLI stores a session and refreshes it automatically.

In Sandbox or CI, `COHUB_EXECUTION_TOKEN` can override stored auth for ephemeral runs.

## Environments

Production is the default.

```bash
ENV=dev cohub auth login
ENV=dev cohub spaces ls
```

## Global flags

| Flag | Purpose |
| --- | --- |
| `-s, --space <id>` | Target Space for space-scoped commands |
| `--json` | Machine-readable output |
| `-h, --help` | Command help |

Many workflows need a Space:

```bash
cohub -s <spaceId> spaces get
COHUB_SPACE_ID=<spaceId> cohub spaces get
```

## Terminology

| UI | CLI |
| --- | --- |
| Chat | Session |
| Save | Checkpoint |
| Tasks | Task runs |
| Scheduled prompt | `spaces prompt` schedule / cron jobs |

## Common workflows

### Spaces

```bash
cohub spaces ls --json
cohub spaces create --name "Demo" --json
cohub spaces get <spaceId> --json
cohub -s <spaceId> spaces files ls
```

### Prompt a Chat

```bash
cohub -s <spaceId> spaces prompt "Fix the failing tests" --json
cohub -s <spaceId> spaces prompt --title "Planning" "Draft a launch plan" --json
cohub -s <spaceId> spaces prompt --session <sessionId> "Continue from the diff" --json
```

Schedule:

```bash
cohub -s <spaceId> spaces prompt --at "2026-07-20T09:00:00+08:00" "Weekly review" --json
```

### Run a command in the Space workspace

```bash
cohub -s <spaceId> run -- git status
```

### Files

```bash
cohub -s <spaceId> spaces files ls
cohub -s <spaceId> spaces files cat README.md
cohub -s <spaceId> spaces files write notes.md --stdin < notes.md
cohub -s <spaceId> spaces files upload ./src
cohub -s <spaceId> spaces files diff
```

### Works

```bash
cohub -s <spaceId> works publish demo --file dist/index.html
cohub -s <spaceId> works publish site --dir dist
cohub -s <spaceId> works ls --json
cohub works stats <workId|url|username/space/work>
```

Realtime rooms use a published Work's runtime identity. Use
`client.work.realtime` inside the Work; the CLI intentionally has no room
commands.

### Drive the Cohub UI

An Agent running in a Space can show a Work preview in the Cohub tab the chat
started from, and call methods the Work exposes.

```bash
cohub ui preview <workId|url|cohub://works/...|username/space/work>
cohub ui preview <work> --call selection.get
cohub ui preview <work> --call board.focus --data '{"nodeId":"n1"}'
```

Showing a preview is idempotent: repeating it re-activates the same tab. `--call`
waits for the Work to announce readiness, then invokes the method. Which methods
exist is up to the Work author, registered with
`client.work.surface.handle(name, handler)`.

Commands only ever reach the frontend instance that originated the current work,
resolved from request provenance. They cannot target another user, and there is
no DOM access or script evaluation.

### Local Sandbox

Expose a local folder as the Space Sandbox:

```bash
cohub sandbox up ./my-project
cohub sandbox status
```

### Search and models

```bash
cohub search "release notes"
cohub models ls
cohub models ls --model-type multimodal
cohub generate "A calm lake at sunrise" --model <model> --output lake.png
```

## Output discipline

Use `--json` whenever a script or Agent needs to chain commands.

```bash
cohub spaces ls --json
cohub -s <spaceId> spaces sessions ls --json
```

Human-readable output is fine for interactive use. JSON is better for automation.

## Next steps

- Product loop from the UI: [Quick start](/docs/learn/quick-start)
- Programmatic access: [SDK](/docs/developers/sdk)
- Publishing details: [Works](/docs/create/works)
