---
title: Works
description: Publish a Space file, directory, or port as a shareable Cohub Work with versions and permissions.
---

A Work is a published, shareable surface created from a Space.

Use Works when something should open directly: a static page, a small site, a demo app, or a runtime that can request Cohub permissions.

## What a Work is

A Work belongs to one Space and records:

| Field | Meaning |
| --- | --- |
| Slug | Public name in the URL |
| Status | `published` or `disabled` |
| Target type | `file`, `directory`, or `port` |
| Target ref | Path or port number |
| Work scopes | Permissions granted directly to the Work |
| Allowed viewer scopes | Permissions the Work may request from each viewer |

Public URL shape:

```text
/:username/:spaceSlug/w/:workSlug
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
4. Set the Work slug
5. Choose Work scopes and allowed viewer scopes
6. Publish and open the public URL

The Work also appears in the Space sidebar under Works.

## Manage a Work

From the Work management page you can:

- Preview the Work in the workspace, beside the management page
- Open the public page in a new tab
- Edit slug, target, status, and permissions
- Publish a new version from the current target
- Disable or delete the Work
- Copy the Work id for CLI/SDK use

Important behavior:

- Editing the target changes the source for the **next** version
- The public page updates when you publish / update a version
- Disabling removes the Work from public by-slug access

## Versions

Works are versioned snapshots of the chosen target.

That means you can iterate in the Space, then deliberately publish when the output is ready. Treat version publish as a release action, not an autosave.

## Permissions

Works have two permission layers:

1. **Work scopes** — what the Work itself may do
2. **Allowed viewer scopes** — what the Work may ask a viewer to grant

This matters when a Work uses the Cohub SDK inside the published runtime to read context, prompt, generate, or access approved resources.

If your Work is only static HTML, you may need little or no runtime scope.

## Work runtime note

`context()`, viewer authorization, and Work commerce APIs only work inside a **published** Work runtime hosted by Cohub.

They do not work from a raw static asset URL or a random local preview shell. Develop those capabilities against a published Work.

## Publish from CLI

```bash
cohub -s <spaceId> works publish demo --file dist/index.html
cohub -s <spaceId> works publish site --dir dist
cohub -s <spaceId> works publish app --port 5173
```

Useful follow-ups:

```bash
cohub -s <spaceId> works ls --json
cohub works get <workId|url|username/space/work> --json
cohub works stats <workId|url|username/space/work>
cohub works download <workId|url|username/space/work> --output <path>
cohub works publish-version <workId>
```

`works download` restores newly published file and directory artifacts directly from the CDN and verifies their checksums. HTML files with companion assets are restored as directory bundles. Board and port Works are not downloadable.

## Practical tips

- Stabilize paths before sharing a URL widely
- Save a checkpoint before major publish milestones
- Use clear slugs: `pitch`, `v1`, `docs-demo`
- Disable instead of delete when you only need to take a Work offline
- For SDK-powered Works, decide scopes intentionally — least privilege first

## Related

- [Quick start](/docs/learn/quick-start)
- [Files & Sandbox](/docs/workspace/files-and-sandbox)
- [SDK](/docs/developers/sdk)
