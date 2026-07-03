#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="$(dirname "$SCRIPT_DIR")/manifests"

get_value() {
  local key="$1"
  grep -E "^${key}:" values.yaml | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^"//' | sed 's/"$//'
}

NAMESPACE=$(get_value "NAMESPACE")
APP_NAME=$(get_value "APP_NAME")
IMAGE_REPOSITORY=$(get_value "IMAGE_REPOSITORY")
IMAGE_TAG=${OVERRIDE_IMAGE_TAG:-$(get_value "IMAGE_TAG")}
IMAGE_PULL_POLICY=$(get_value "IMAGE_PULL_POLICY")
IMAGE_PULL_SECRET=$(get_value "IMAGE_PULL_SECRET")
SECRET_REF_NAME=$(get_value "SECRET_REF_NAME")
SERVICE_PORT=$(get_value "SERVICE_PORT")
CONTAINER_PORT=$(get_value "CONTAINER_PORT")
REPLICAS=$(get_value "REPLICAS")
MAX_UNAVAILABLE=$(get_value "MAX_UNAVAILABLE")
MAX_SURGE=$(get_value "MAX_SURGE")
TERMINATION_GRACE_PERIOD_SECONDS=$(get_value "TERMINATION_GRACE_PERIOD_SECONDS")
REQUEST_CPU=$(get_value "REQUEST_CPU")
REQUEST_MEMORY=$(get_value "REQUEST_MEMORY")
LIMIT_CPU=$(get_value "LIMIT_CPU")
LIMIT_MEMORY=$(get_value "LIMIT_MEMORY")
LIVENESS_PATH=$(get_value "LIVENESS_PATH")
LIVENESS_INITIAL_DELAY=$(get_value "LIVENESS_INITIAL_DELAY")
LIVENESS_PERIOD=$(get_value "LIVENESS_PERIOD")
LIVENESS_TIMEOUT=$(get_value "LIVENESS_TIMEOUT")
LIVENESS_FAILURE_THRESHOLD=$(get_value "LIVENESS_FAILURE_THRESHOLD")
READINESS_PATH=$(get_value "READINESS_PATH")
READINESS_INITIAL_DELAY=$(get_value "READINESS_INITIAL_DELAY")
READINESS_PERIOD=$(get_value "READINESS_PERIOD")
READINESS_TIMEOUT=$(get_value "READINESS_TIMEOUT")
READINESS_FAILURE_THRESHOLD=$(get_value "READINESS_FAILURE_THRESHOLD")
LOGTO_ENDPOINT=$(get_value "LOGTO_ENDPOINT")
SPACE_STORAGE_ROOT=$(get_value "SPACE_STORAGE_ROOT")
SPACE_SYSTEM_ROOT=$(get_value "SPACE_SYSTEM_ROOT")
SPACE_STORAGE_PVC=$(get_value "SPACE_STORAGE_PVC")
SPACE_SYSTEM_PVC=$(get_value "SPACE_SYSTEM_PVC")
SPACE_STORAGE_SUBPATH=$(get_value "SPACE_STORAGE_SUBPATH")
SPACE_SYSTEM_SUBPATH=$(get_value "SPACE_SYSTEM_SUBPATH")
TURN_OBJECT_S3_ENDPOINT=$(get_value "TURN_OBJECT_S3_ENDPOINT")
TURN_OBJECT_S3_REGION=$(get_value "TURN_OBJECT_S3_REGION")
TURN_OBJECT_S3_BUCKET=$(get_value "TURN_OBJECT_S3_BUCKET")
TURN_OBJECT_CDN_BASE_URL=$(get_value "TURN_OBJECT_CDN_BASE_URL")
ROUTE_ENABLED=$(get_value "ROUTE_ENABLED")
API_HOSTNAME=$(get_value "API_HOSTNAME")
ENV=$(get_value "ENV")
LOG_LEVEL=$(get_value "LOG_LEVEL")

# 复用 api 的 Secret，无需本地 secrets.yaml

mkdir -p rendered

render_template() {
  local src="$1"; local dst="$2"; cp "$src" "$dst"
  python - "$dst" "$IMAGE_PULL_SECRET" <<'PY'
from pathlib import Path; import sys
path = Path(sys.argv[1]); secret = sys.argv[2]; text = path.read_text()
placeholder = "__IMAGE_PULL_SECRETS_BLOCK__\n"
if placeholder in text:
    replacement = f"      imagePullSecrets:\n        - name: {secret}\n" if secret else ""
    text = text.replace(placeholder, replacement)
path.write_text(text)
PY
  sed -i.bak \
    -e "s|__NAMESPACE__|${NAMESPACE}|g" -e "s|__APP_NAME__|${APP_NAME}|g" \
    -e "s|__IMAGE_REPOSITORY__|${IMAGE_REPOSITORY}|g" -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
    -e "s|__IMAGE_PULL_POLICY__|${IMAGE_PULL_POLICY}|g" -e "s|__SERVICE_PORT__|${SERVICE_PORT}|g" \
    -e "s|__SECRET_REF_NAME__|${SECRET_REF_NAME}|g" \
    -e "s|__CONTAINER_PORT__|${CONTAINER_PORT}|g" -e "s|__REPLICAS__|${REPLICAS}|g" \
    -e "s|__MAX_UNAVAILABLE__|${MAX_UNAVAILABLE}|g" -e "s|__MAX_SURGE__|${MAX_SURGE}|g" \
    -e "s|__TERMINATION_GRACE_PERIOD_SECONDS__|${TERMINATION_GRACE_PERIOD_SECONDS}|g" \
    -e "s|__REQUEST_CPU__|${REQUEST_CPU}|g" -e "s|__REQUEST_MEMORY__|${REQUEST_MEMORY}|g" \
    -e "s|__LIMIT_CPU__|${LIMIT_CPU}|g" -e "s|__LIMIT_MEMORY__|${LIMIT_MEMORY}|g" \
    -e "s|__LIVENESS_PATH__|${LIVENESS_PATH}|g" -e "s|__LIVENESS_INITIAL_DELAY__|${LIVENESS_INITIAL_DELAY}|g" \
    -e "s|__LIVENESS_PERIOD__|${LIVENESS_PERIOD}|g" -e "s|__LIVENESS_TIMEOUT__|${LIVENESS_TIMEOUT}|g" \
    -e "s|__LIVENESS_FAILURE_THRESHOLD__|${LIVENESS_FAILURE_THRESHOLD}|g" \
    -e "s|__READINESS_PATH__|${READINESS_PATH}|g" -e "s|__READINESS_INITIAL_DELAY__|${READINESS_INITIAL_DELAY}|g" \
    -e "s|__READINESS_PERIOD__|${READINESS_PERIOD}|g" -e "s|__READINESS_TIMEOUT__|${READINESS_TIMEOUT}|g" \
    -e "s|__READINESS_FAILURE_THRESHOLD__|${READINESS_FAILURE_THRESHOLD}|g" \
    -e "s|__LOGTO_ENDPOINT__|${LOGTO_ENDPOINT}|g" -e "s|__SPACE_STORAGE_ROOT__|${SPACE_STORAGE_ROOT}|g" \
    -e "s|__SPACE_SYSTEM_ROOT__|${SPACE_SYSTEM_ROOT}|g" -e "s|__SPACE_STORAGE_PVC__|${SPACE_STORAGE_PVC}|g" \
    -e "s|__SPACE_SYSTEM_PVC__|${SPACE_SYSTEM_PVC}|g" -e "s|__SPACE_STORAGE_SUBPATH__|${SPACE_STORAGE_SUBPATH}|g" \
    -e "s|__SPACE_SYSTEM_SUBPATH__|${SPACE_SYSTEM_SUBPATH}|g" -e "s|__TURN_OBJECT_S3_ENDPOINT__|${TURN_OBJECT_S3_ENDPOINT}|g" \
    -e "s|__TURN_OBJECT_S3_REGION__|${TURN_OBJECT_S3_REGION}|g" -e "s|__TURN_OBJECT_S3_BUCKET__|${TURN_OBJECT_S3_BUCKET}|g" \
    -e "s|__TURN_OBJECT_CDN_BASE_URL__|${TURN_OBJECT_CDN_BASE_URL}|g" -e "s|__API_HOSTNAME__|${API_HOSTNAME}|g" \
    -e "s|__ENV__|${ENV}|g" -e "s|__LOG_LEVEL__|${LOG_LEVEL:-info}|g" \
    "$dst"
  rm -f "$dst.bak"
}

render_template "$MANIFESTS_DIR/configmap.tmpl.yaml" rendered/configmap.yaml
render_template "$MANIFESTS_DIR/deployment.tmpl.yaml" rendered/deployment.yaml
render_template "$MANIFESTS_DIR/service.tmpl.yaml" rendered/service.yaml
kubectl apply -f rendered/configmap.yaml
kubectl apply -f rendered/service.yaml
kubectl apply -f rendered/deployment.yaml

if [ "$ROUTE_ENABLED" = "true" ]; then
  render_template "$MANIFESTS_DIR/httproute.tmpl.yaml" rendered/httproute.yaml
  kubectl apply -f rendered/httproute.yaml
fi

echo "✅ fs-api deployed"
echo "  kubectl get pods -n ${NAMESPACE} -l app.kubernetes.io/name=${APP_NAME}"
