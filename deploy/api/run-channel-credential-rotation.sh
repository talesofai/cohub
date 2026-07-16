#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="${1:-}"
APPLY="${2:-}"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <dev|prod> [--apply]" >&2
  exit 1
fi
if [[ -n "$APPLY" && "$APPLY" != "--apply" ]]; then
  echo "Second argument must be --apply when provided" >&2
  exit 1
fi

ENV_DIR="$SCRIPT_DIR/$ENVIRONMENT"
VALUES_FILE="$ENV_DIR/values.yaml"
if [[ ! -f "$VALUES_FILE" ]]; then
  echo "Missing $VALUES_FILE" >&2
  exit 1
fi

get_value() {
  local key="$1"
  grep -E "^${key}:" "$VALUES_FILE" | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^"//' | sed 's/"$//'
}

NAMESPACE="$(get_value NAMESPACE)"
APP_NAME="$(get_value APP_NAME)"
IMAGE_REPOSITORY="$(get_value IMAGE_REPOSITORY)"
IMAGE_TAG="${OVERRIDE_IMAGE_TAG:-$(get_value IMAGE_TAG)}"
IMAGE_PULL_POLICY="$(get_value IMAGE_PULL_POLICY)"
IMAGE_PULL_SECRET="$(get_value IMAGE_PULL_SECRET)"
JOB_NAME="${APP_NAME}-channel-credential-rotation"
RENDERED_DIR="$ENV_DIR/rendered"
RENDERED_FILE="$RENDERED_DIR/channel-credential-rotation-job.yaml"

mkdir -p "$RENDERED_DIR"
cp "$SCRIPT_DIR/manifests/channel-credential-rotation-job.tmpl.yaml" "$RENDERED_FILE"

python3 - "$RENDERED_FILE" "$IMAGE_PULL_SECRET" "$APPLY" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
image_pull_secret = sys.argv[2]
apply = sys.argv[3]
text = path.read_text()
pull_block = ""
if image_pull_secret:
    pull_block = f"      imagePullSecrets:\n        - name: {image_pull_secret}\n"
args_block = '          args:\n            - "--apply"\n' if apply == "--apply" else ""
text = text.replace("__IMAGE_PULL_SECRETS_BLOCK__\n", pull_block)
text = text.replace("__ARGS_BLOCK__\n", args_block)
path.write_text(text)
PY

sed -i.bak \
  -e "s|__NAMESPACE__|${NAMESPACE}|g" \
  -e "s|__APP_NAME__|${APP_NAME}|g" \
  -e "s|__IMAGE_REPOSITORY__|${IMAGE_REPOSITORY}|g" \
  -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
  -e "s|__IMAGE_PULL_POLICY__|${IMAGE_PULL_POLICY}|g" \
  "$RENDERED_FILE"
rm -f "$RENDERED_FILE.bak"

kubectl delete job "$JOB_NAME" -n "$NAMESPACE" --ignore-not-found
kubectl apply -f "$RENDERED_FILE"
if ! kubectl wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=1800s; then
  kubectl logs "job/$JOB_NAME" -n "$NAMESPACE" --tail=200 || true
  exit 1
fi
kubectl logs "job/$JOB_NAME" -n "$NAMESPACE"
