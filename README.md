# Cohub

*Your own space to create, play, and build with people and agents.*

We burn 100 billion tokens per week inside our company within Cohub Spaces.

Cohub is a living Space for people and agents. Start anywhere, make in any medium, share as Works.

It combines:
- a browser-first Space for conversation, files, sessions, tasks, and previews
- checkpoint-based saving, forking, and remixing
- multimodal generation for text, image, video, and music
- public Spaces and Works for discovery and sharing
- CLI and external channels for people and agents to act from anywhere

## Core Ideas

### Fun to start
Open a Space and play with ideas, prompts, files, and agents.

### Build together
People and agents in one context. Co-create, save, and share.

### Open everywhere
Web, mobile, CLI, Discord, WeChat. The Space follows you.

### Powerful for real work
Games, apps, media, automations, custom homes — from playful to production.

### Never start blank
Fork a checkpoint into a new Space, or reference any Space with `@space` as context.

## Core Concepts

### Space
A Space is the main creative surface in Cohub.

It is a live, isolated environment where people and agents work together. A Space holds conversations, files, drafts, outputs, and experiments in one place.

### Checkpoint
A Checkpoint is an immutable snapshot saved from a Space.

It preserves a meaningful moment, and can be shared, forked, restored, or used as a stable base for new work.

### Agent
An Agent is the active collaborator operating inside a Space.

### Session
A Session is a conversation context inside a Space. Each Session keeps its own history and can evolve independently.

### Channel
A Channel is an external entry point connected to a Space.

Examples include Web, Discord, Telegram, Feishu, and WeChat. People can talk from those channels, and agents can respond back through them.

### Sandbox
A Sandbox is the execution environment behind a Space.

It provides runtime capabilities while staying behind the product surface.

## Product Shape

Cohub is built around one idea: **people create in Spaces, and useful context gets saved as Checkpoints**.

The platform is for:
- creating with people and agents in live Spaces
- saving milestones as Checkpoints
- forking from Checkpoints into new Spaces
- publishing Works from files, directories, or ports
- using CLI and APIs to automate the same product surface

> Cohub is a shared creative space for people and agents to create, save, share, and build from real context.

## Repository Structure

```text
cohub/
├── apps/
│   ├── api/          # Hono API — orchestration, provisioning, session persistence
│   ├── agent/        # Agent control service — Pi coding agent, WS client connecting to sandbox
│   ├── sandbox/      # Sandbox executor — Go WS server for workspace / fs / process
│   ├── gateway/      # External channel gateway (Discord, Telegram, Feishu, WeChat, etc.)
│   ├── web/          # SvelteKit web app
│   └── worker/       # Task scheduler — cron jobs and async task processing
├── deploy/           # Deployment configs (per environment)
├── docs/             # Architecture, guides, and examples
├── packages/
│   ├── billing/              # Billing provider abstraction
│   ├── cli/                  # @neta-art/cohub-cli
│   ├── core/                 # Shared server-side domain logic
│   ├── db/                   # Drizzle schema and DB helpers
│   ├── identity/             # Auth / identity helpers
│   ├── infra/                # Infra helpers (Redis, storage, telemetry)
│   ├── protocol/             # Shared types and protocols (private)
│   ├── sandbox-client/       # Agent-side sandbox WS client
│   ├── sandbox-controller/   # Sandbox provisioning controller
│   └── sdk/                  # @neta-art/cohub client SDK
├── scripts/          # Utility scripts
└── README.md
```

## Tech Stack

- **Language**: TypeScript + Go
- **Frontend**: SvelteKit
- **Backend**: Hono
- **Agent Runtime**: pi-coding-agent (WS client, connects to sandbox)
- **Sandbox Runtime**: Go + WebSocket server
- **Database**: PostgreSQL + Drizzle ORM
- **Infrastructure**: Kubernetes (ACK)
- **Package Manager**: pnpm monorepo

## Development

```bash
pnpm install
pnpm dev
```

### Quality Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Docs

Product docs (web):
- English: [cohub.run/docs](https://cohub.run/docs)
- 中文: [cohub.run/docs/zh](https://cohub.run/docs/zh)

Source of truth for product docs content:
- `docs/product/en/`
- `docs/product/zh/`

Engineering notes still in the repo:
- `docs/self-hosting.md`
- `docs/agent-sandbox-runtime.md`
- `docs/works-guide.md`
- `docs/work-commerce-guide.md`
- `docs/generations.md`
- `docs/space-hooks.md`
- `docs/examples/` — generation declarations, Work capability lab, and other samples

## Open Source Notes

- License: Apache License 2.0 (Viscept Limited)
- Billing is disabled by default; configure `TALESOFAI_BILLING_*` to enable the hosted billing provider
- OpenTelemetry remote export is opt-in via `OTEL_EXPORTER_OTLP_*`
- Copy `deploy/**/values.example.yaml` to local `values.yaml` for deploys
- Self-hosting guide: `docs/self-hosting.md`
- Security reports: `SECURITY.md` or `dev@talesof.ai`

## License

Apache License 2.0 © Viscept Limited

