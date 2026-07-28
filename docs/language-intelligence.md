# Language intelligence

Cohub exposes bounded Language Server Protocol (LSP) queries to the coding
agent through the Space Sandbox.

## Supported languages

- TypeScript and JavaScript through `typescript-language-server`
- Go through `gopls`
- Python through `basedpyright-langserver`

The Sandbox image pins the language-server versions. Native/local Sandbox
runners discover the same executables from `PATH`, or from:

- `LSP_TYPESCRIPT_EXECUTABLE`
- `LSP_TYPESCRIPT_TSSERVER_PATH`
- `LSP_GO_EXECUTABLE`
- `LSP_PYTHON_EXECUTABLE`

## Read-only actions

The Agent `lsp` tool and Sandbox `lsp.query` RPC support:

- `status`
- `diagnostics`
- `definition`
- `references`
- `hover`
- `symbols`

The interface does not expose rename, formatting, code actions, raw LSP
requests, `workspace/applyEdit`, or file mutation. Returned locations and
symbols are filtered to the current Space before they cross the Sandbox RPC
boundary.

Language-server processes are isolated per connection identity, language, and
workspace root. Requests have bounded timeouts and result limits. Idle clients
are shut down automatically, and disconnect cleanup terminates their managed
processes.

## Local Sandbox trust boundary

Read-only describes the Cohub tool and RPC contract. A local Sandbox language
server follows the same host trust model as `process.start`: it runs as the
current user and is not an OS security boundary. Run the local Sandbox inside a
container or VM when host-level isolation is required.

## Runtime limits

The following environment variables tune bounded runtime behavior:

- `LSP_REQUEST_TIMEOUT_MS` defaults to `5000` and accepts `250..60000`.
- `LSP_IDLE_TIMEOUT_SECS` defaults to `300` and accepts `5..3600`.
- `LSP_MAX_MESSAGE_BYTES` defaults to `4194304` and accepts
  `65536..16777216`.

## Validation

Run the focused contract:

```bash
pnpm test:lsp
```

The contract covers JSON-RPC framing, cancellation, diagnostics and navigation
normalization, result bounds, owner/root isolation, managed stdin lifecycle,
Sandbox path filtering, protocol types, and the Agent tool boundary.

With all three servers available on `PATH`, run the opt-in process integration
from `apps/sandbox`:

```bash
COHUB_LSP_INTEGRATION=typescript,go,python \
  go test ./lsp -run TestRealLanguageServers -count=1
```
