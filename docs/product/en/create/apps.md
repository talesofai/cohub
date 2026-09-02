---
title: Apps
description: Publish a Space file, directory, or port as a shareable Cohub App with versions and permissions.
---

An App is a published, shareable surface created from a Space.

Use Apps when something should open directly: a static page, a small site, a demo app, or a runtime that can request Cohub permissions.

## What an App is

An App belongs to one Space and records:

| Field | Meaning |
| --- | --- |
| Slug | Public name in the URL |
| Status | `published` or `disabled` |
| Target type | `file`, `directory`, or `port` |
| Target ref | Path or port number |
| App scopes | Permissions granted directly to the App at publish time |

Public URL shape:

```text
/:username/:spaceSlug/w/:appSlug
```

## Choose a target

| Target | Best for | Notes |
| --- | --- | --- |
| File | Single HTML document | Path should end in `.html` / `.htm` |
| Directory | Static site | Usually needs `index.html` and relative assets |
| Port | Live app in Sandbox | Process must be listening on a supported public port |

Pick the simplest target that matches the output.

## Publish from the UI

1. Prepare the file, directory, or running port in a Space
2. Open its preview
3. Click **Publish**
4. Set the App slug
5. Under **App can**, choose the scopes the App receives directly
6. Publish and open the public URL

The App also appears in the Space sidebar under Apps.

## Manage an App

From the App management page you can:

- Preview the App in the workspace, beside the management page
- Open the public page in a new tab
- Edit slug, target, status, and permissions
- Publish a new version from the current target
- Disable or delete the App
- Copy the App id for CLI/SDK use

Important behavior:

- Editing the target changes the source for the **next** version
- The public page updates when you publish / update a version
- Disabling removes the App from public by-slug access

## Versions

Apps are versioned snapshots of the chosen target.

That means you can iterate in the Space, then deliberately publish when the output is ready. Treat version publish as a release action, not an autosave.

## Permissions

An App's effective permission for one Space is the union of two grant sources —
either one is enough:

1. **App scopes** — eight bounded scopes (`space.view`, `session.view`,
   `file.view`, `file.edit`, `taskrun.view`, `session.prompt.readonly`,
   `session.prompt.fullaccess`, `command.execute`) granted at publish time.
   They apply only to the App's own Space.
2. **Viewer grants** — any permission the viewer holds, on any Space they
   choose, approved through a consent dialog at runtime. Grants are per Space,
   last 14 days, and never exceed what the viewer can already do there. A
   viewer can review and revoke their grants at any time (`cohub apps grants`,
   `cohub apps revoke`).

This matters when an App uses the Cohub SDK inside the published runtime to read context, prompt, generate, or access approved resources.

If your App is only static HTML, you may need little or no runtime scope.

## Runtime note

`context()`, viewer authorization, and commerce APIs only work inside a **published** App runtime hosted by Cohub.

They do not work from a raw static asset URL or a random local preview shell. Develop those capabilities against a published App.

## Publish from CLI

`--file` and `--dir` take paths relative to the Space workspace — the same paths
`spaces files ls` shows, not your local filesystem. To publish local build
output, upload it first (`spaces files upload <dir>`), then publish the
Space-side path.

```bash
cohub -s <spaceId> apps publish demo --file dist/index.html
cohub -s <spaceId> apps publish site --dir dist
cohub -s <spaceId> apps publish app --port 5173
```

Useful follow-ups:

```bash
cohub -s <spaceId> apps ls --json
cohub apps get <appId|url|username/space/app> --json
cohub apps stats <appId|url|username/space/app>
cohub apps download <appId|url|username/space/app> --output <path>
cohub apps publish-version <appId>
```

`apps download` restores newly published file and directory artifacts directly from the CDN and verifies their checksums. HTML files with companion assets are restored as directory bundles. Board and port apps are not downloadable.

## Practical tips

- Stabilize paths before sharing a URL widely
- Save a checkpoint before major publish milestones
- Use clear slugs: `pitch`, `v1`, `docs-demo`
- Disable instead of delete when you only need to take an App offline
- For SDK-powered Apps, decide scopes intentionally — least privilege first

## Related

- [App development](/docs/developers/apps)
- [Quick start](/docs/learn/quick-start)
- [Files & Sandbox](/docs/workspace/files-and-sandbox)
- [SDK](/docs/developers/sdk)
