---
title: Product map
description: A compact map of the Cohub UI — sidebar, Chat, preview, and settings.
---

This page maps the product surface so the rest of the docs have a shared layout language.

## App shell

After sign-in, Cohub is a workspace shell:

- **Left sidebar** — Space switcher, Chats, Saves, Apps, tasks, labels, and account entry points
- **Main panel** — usually a Chat, sometimes a settings or management page
- **Preview / files surface** — open files, directories, and ports beside the conversation
- **Command palette** — `⌘K` / `Ctrl K` for global search and navigation
- **Help** — `?` for keyboard shortcuts

On mobile, the same pieces become drawers and stacked screens instead of a multi-pane desktop layout.

## Sidebar

The sidebar is the navigation spine of a Space.

Typical groups:

| Area | What it holds |
| --- | --- |
| Space header | Current Space, switcher, settings entry |
| Chats | Conversation list, often organized by labels |
| Saves | Checkpoint history |
| Apps | Published surfaces for the Space |
| Tasks / schedules | Async runs and scheduled prompts |
| Labels | Custom and system organization |

If something “disappeared”, check labels and collapsed sections before assuming it was deleted.

## Chat surface

A Chat page is built around:

1. **Transcript** — turns, tool calls, streaming output
2. **Composer** — message input, model picker, attachments, slash commands, skills, mentions
3. **Turn tools** — navigation, fork, follow-up control, share/access when available

Composer is part of Chat, not a separate product area. The important actions are:

- Choose a model
- Send or force-send
- Attach files or images
- Use `/` prompts and `/skill:` skills
- Mention other Spaces with `@space` when you need outside context

## Files and preview

Workspace files live with the Space, not only in the Chat transcript.

Common actions:

- Browse and open files
- Edit text files
- Upload local files
- Preview rendered HTML and other supported files
- Open public Sandbox ports for live apps

Chat and preview are meant to work together: talk in one pane, inspect artifacts in the other.

## Space settings

Space settings cover the durable configuration of a Space:

- Profile, slug, and avatar
- Members and roles
- Access policy for signed-in and anonymous users
- Channels
- Mods
- Sandbox size / hibernation behavior
- Environment variables
- Commerce, when enabled

Use settings for setup. Use Chat + Files for day-to-day creation.

## Global surfaces

Outside a single Space you also have:

| Surface | Role |
| --- | --- |
| Sessions inbox | Cross-space recent Chats |
| Trending | Discovery of public activity |
| Public App page | `/:username/:spaceSlug/w/:appSlug` |
| Account settings | Profile, appearance, billing, referrals, channel defaults |

## Mental model

```text
Account
  └── Spaces
        ├── Chats + Composer
        ├── Files + Sandbox + Preview
        ├── Saves
        ├── Apps
        ├── Tasks / Scheduled prompts
        ├── Labels
        └── Settings (members, access, channels, mods, env)
```

When you are lost, ask: **which Space am I in, and which object am I looking at?**
