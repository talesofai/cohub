const APP_ACTION_RE = /^[a-z0-9_-]+$/;

export const APP_ACTION_INPUT_MAX_BYTES = 16 * 1024;

export function isAppActionKey(value: string): boolean {
  return APP_ACTION_RE.test(value);
}

const SHELL_QUOTE_ESCAPE = `'"'"'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", SHELL_QUOTE_ESCAPE)}'`;

export function buildAppActionCommand(input: {
  appId: string;
  appVersionId: string;
  action: string;
  actionInput: unknown;
}) {
  const cache = `/tmp/cohub-app-actions/${input.appId}/${input.appVersionId}`;
  const encodedInput = Buffer.from(JSON.stringify(input.actionInput ?? null)).toString("base64");
  return [
    "set -euo pipefail",
    `cache=${shellQuote(cache)}`,
    `action=${shellQuote(input.action)}`,
    `expected_version=${shellQuote(input.appVersionId)}`,
    'if [[ ! -d "$cache" ]]; then',
    '  mkdir -p "$(dirname "$cache")"',
    '  stage="$(mktemp -d "$(dirname "$cache")/.download.XXXXXX")"',
    `  current_version() { cohub --json apps get ${shellQuote(input.appId)} | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).app.currentVersionId ?? ""))'; }`,
    '  if [[ "$(current_version)" != "$expected_version" ]]; then rm -rf "$stage"; echo "App version changed; retry the Action" >&2; exit 75; fi',
    `  cohub --json apps download ${shellQuote(input.appId)} --output "$stage/app" >/dev/null`,
    '  if [[ "$(current_version)" != "$expected_version" ]]; then rm -rf "$stage"; echo "App version changed; retry the Action" >&2; exit 75; fi',
    '  if ! mv -T "$stage/app" "$cache" 2>/dev/null; then rm -rf "$stage/app"; fi',
    '  rm -rf "$stage"',
    "fi",
    'if command -v npm >/dev/null && [[ ! -e "$cache/node_modules/@neta-art/cohub" ]]; then',
    '  global_modules="$(npm root -g)"',
    '  sdk="$global_modules/@neta-art/cohub"',
    '  dependency_root="$global_modules/@neta-art/cohub-cli/node_modules"',
    '  [[ -d "$sdk" ]] || sdk="$dependency_root/@neta-art/cohub"',
    '  if [[ -d "$sdk" ]]; then mkdir -p "$cache/node_modules/@neta-art"; ln -s "$sdk" "$cache/node_modules/@neta-art/cohub" 2>/dev/null || true; fi',
    '  if [[ -d "$dependency_root" ]]; then',
    '    for dependency in "$dependency_root"/*; do',
    '      [[ -e "$dependency" ]] || continue',
    '      name="$(basename "$dependency")"',
    '      [[ "$name" == "@neta-art" ]] && continue',
    '      ln -s "$dependency" "$cache/node_modules/$name" 2>/dev/null || true',
    '    done',
    '    for dependency in "$dependency_root/@neta-art"/*; do',
    '      [[ -e "$dependency" ]] || continue',
    '      name="$(basename "$dependency")"',
    '      [[ "$name" == "cohub" ]] && continue',
    '      ln -s "$dependency" "$cache/node_modules/@neta-art/$name" 2>/dev/null || true',
    '    done',
    '  fi',
    "fi",
    'shopt -s nullglob',
    'entries=()',
    '[[ -f "$cache/.cohub/actions/$action" ]] && entries+=("$cache/.cohub/actions/$action")',
    'for candidate in "$cache/.cohub/actions/$action".*; do [[ -f "$candidate" ]] && entries+=("$candidate"); done',
    // Split Bash's ${...} syntax so static analysis does not read it as a JavaScript placeholder.
    'if (( $' + '{#entries[@]} == 0 )); then echo "App action not found: $action" >&2; exit 66; fi',
    'if (( $' + '{#entries[@]} > 1 )); then echo "App action is ambiguous: $action" >&2; exit 66; fi',
    'entry="$' + '{entries[0]}"',
    `input=${shellQuote(encodedInput)}`,
    'case "$entry" in',
    '  *.ts|*.mts|*.cts|*.js|*.mjs|*.cjs) printf %s "$input" | base64 -d | node "$entry" ;;',
    '  *) chmod +x "$entry"; printf %s "$input" | base64 -d | "$entry" ;;',
    "esac",
  ].join("\n");
}
