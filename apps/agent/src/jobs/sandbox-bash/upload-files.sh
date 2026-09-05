#!/usr/bin/env bash
set -euo pipefail

: "${UPLOAD_ROOT:?UPLOAD_ROOT is required}"
: "${MATERIALIZE_MODE:=replace}"
case "$MATERIALIZE_MODE" in
  replace|stage) ;;
  *)
    echo "invalid materialize mode" >&2
    exit 2
    ;;
esac

b64_decode() {
  if base64 --help 2>&1 | grep -q -- '-d'; then
    base64 -d
  else
    base64 -D
  fi
}

root_real="$(mkdir -p "$UPLOAD_ROOT" && cd "$UPLOAD_ROOT" && pwd -P)"
tmp=""
# Atomic workspace uploads hand these files to fs.write after the download
# completes. Keep every staged path until the agent has installed it.
staged=()
cleanup_tmp() {
  [ -z "$tmp" ] || rm -f -- "$tmp"
  for staged_path in "${staged[@]}"; do
    rm -f -- "$staged_path"
  done
}
trap cleanup_tmp EXIT

while IFS=$'\t' read -r rel_b64 expected_size url_b64; do
  [ -n "${rel_b64:-}" ] || continue

  relative_path="$(printf '%s' "$rel_b64" | b64_decode)"
  url="$(printf '%s' "$url_b64" | b64_decode)"

  case "$relative_path" in
    ""|/*|*"/../"*|../*|*"/.."|..)
      echo "invalid relative path: $relative_path" >&2
      exit 2
      ;;
  esac

  target="$root_real/$relative_path"
  parent="$(dirname "$target")"
  mkdir -p "$parent"
  parent_real="$(cd "$parent" && pwd -P)"
  case "$parent_real" in
    "$root_real"|"$root_real"/*) ;;
    *)
      echo "target escapes upload root: $relative_path" >&2
      exit 2
      ;;
  esac

  tmp="$(mktemp "$parent_real/.cohub-upload.XXXXXX")"
  if command -v curl >/dev/null 2>&1; then
    # No redirects: materialize URLs must already be allowed public-asset origins.
    # Cap download size to declared size (+1) so forged small sizes cannot stream unbounded.
    curl -fsS --max-redirs 0 --max-filesize "$((expected_size + 1))" --retry 3 --retry-delay 1 --connect-timeout 10 -o "$tmp" "$url" || {
      curl_exit=$?
      if [ "$curl_exit" -eq 63 ]; then
        echo "download exceeds declared size for $relative_path" >&2
        exit 3
      fi
      exit "$curl_exit"
    }
  elif command -v wget >/dev/null 2>&1; then
    # wget has no portable max-filesize; size is still verified after download.
    wget -q --max-redirect=0 -O "$tmp" "$url"
  else
    echo "curl or wget is required" >&2
    exit 127
  fi

  actual_size="$(wc -c < "$tmp" | tr -d ' ')"
  if [ "$actual_size" != "$expected_size" ]; then
    echo "size mismatch for $relative_path: expected $expected_size, got $actual_size" >&2
    exit 3
  fi

  if [ "$MATERIALIZE_MODE" = "stage" ]; then
    staged+=("$tmp")
    printf 'staged\t%s\t%s\t%s\n' "$relative_path" "$target" "$tmp"
    tmp=""
  else
    mv -f "$tmp" "$target"
    tmp=""
    printf 'uploaded\t%s\t%s\n' "$relative_path" "$target"
  fi
done

# The agent owns staged files after this point and will remove each source as it
# is installed (or clean the remaining paths on a conflict).
if [ "$MATERIALIZE_MODE" = "stage" ]; then
  staged=()
fi
