---
title: Quick start
description: Create a Space, chat with an Agent, touch files, save a checkpoint, and publish an App.
---

This is the shortest useful loop in Cohub. Aim for one clean pass, not perfection.

## 1. Sign in and open Cohub

Open [cohub.live](https://cohub.live) and sign in.

If you already have Spaces, the app returns you to recent work. Otherwise create a new Space.

## 2. Create a Space

1. Create a Space with a clear name.
2. Optionally set a public slug later in settings.
3. Enter the Space. You land on a new Chat.

A new Space is already a workspace: files, Sandbox, Saves, and Apps are available even if empty.

## 3. Start a Chat

1. Pick a model if needed.
2. Tell the Agent what you want to build or explore.
3. Prefer concrete goals: “scaffold a landing page”, “inspect this repo”, “draft an API”.

Useful first prompts:

```text
Create a minimal static site in this Space and explain the file layout.
```

```text
Review the workspace, then propose a short plan before editing.
```

## 4. Work with files

While the Agent works:

- Open the files tree
- Inspect generated or edited files
- Upload reference assets if needed
- Preview HTML or a running port when available

You do not need to leave Chat to verify progress. Keep the conversation and the workspace side by side.

## 5. Save a checkpoint

When the Space reaches a meaningful state:

1. Create a Save
2. Give it a short label or note you will understand later
3. Confirm the diff looks right

Save after a working milestone, not after every message.

## 6. Publish an App

If the Space has something shareable:

1. Open the HTML file, site directory, or live port
2. Publish it as an App
3. Choose an App slug
4. Open the public URL

App targets:

| Target | Use when |
| --- | --- |
| File | Single HTML page |
| Directory | Static site with `index.html` and assets |
| Port | Live app running in the Sandbox |

## 7. Optional next steps

- Invite a collaborator from Space settings
- Bind a Channel if you want Discord / Telegram / Feishu / WeChat entry points
- Use the [CLI](/docs/developers/cli) for the same loop from a terminal
- Mount Mods or skills when you want reusable tooling

## Done when

You can answer yes to all four:

1. I have a Space
2. I have at least one Chat with useful history
3. I created a Save I could restore or fork from
4. I know how to publish an App when output is ready

Next: dig into [Spaces](/docs/workspace/spaces), [Chats](/docs/workspace/chats), or [Apps](/docs/create/apps).
