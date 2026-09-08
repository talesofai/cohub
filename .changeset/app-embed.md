---
"@cohub/protocol": minor
"@neta-art/cohub": minor
---

Apps can embed other Apps by rendering their public pages in iframes. `cohub.app.embed.attach(frame, { appId, shell, onCloseRequest })` forwards the embedder's shell location and relays the embedded App's close intent; the embedded App sees `context.shell.surface === "embed"` and `context.invocation.embedder`. Any App can call `cohub.app.requestClose()` to ask its host to close the surface it runs in.
