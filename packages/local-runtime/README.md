# Cohub Local Runtime

The local runtime host is an internal child process bundled into the published
Cohub CLI. Users do not install or invoke the host separately. Install the CLI
once, then start local runtimes through the workspace command:

```bash
npm install -g @neta-art/cohub-cli
cohub agent runtime start <spaceId> --root ./project
```

The source package in this workspace hosts the native SDKs behind the
provider-neutral local-runtime JSONL protocol. Commands are read from stdin
and normalized events are written to stdout; diagnostics go to stderr.

The host is intentionally transport-agnostic. A relay or local daemon owns
authentication and workspace fencing, while this process owns SDK sessions and
their native credentials/configuration.
