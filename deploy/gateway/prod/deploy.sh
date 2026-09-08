#!/bin/bash
# Prod 环境部署脚本

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/values.yaml" ]; then
  if [ -f "$SCRIPT_DIR/values.example.yaml" ]; then
    echo "Missing values.yaml. Copy values.example.yaml to values.yaml and edit it first."
  else
    echo "Missing values.yaml."
  fi
  exit 1
fi
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
SERVICE_PORT=$(get_value "SERVICE_PORT")
CONTAINER_PORT=$(get_value "CONTAINER_PORT")
REPLICAS=$(get_value "REPLICAS")
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
API_BASE_URL=$(get_value "API_BASE_URL")
LOGTO_ENDPOINT=$(get_value "LOGTO_ENDPOINT")
ROUTE_ENABLED=$(get_value "ROUTE_ENABLED")
GATEWAY_HOSTNAMES=$(get_value "GATEWAY_HOSTNAMES")
if [ -z "$GATEWAY_HOSTNAMES" ]; then
  GATEWAY_HOSTNAMES=$(get_value "GATEWAY_HOSTNAME")
fi
ENV=$(get_value "ENV")
LOG_LEVEL=$(get_value "LOG_LEVEL")

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cohub Gateway Prod 环境部署          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"

if [ ! -f "secrets.yaml" ]; then
  echo -e "${RED}✗ 缺少 secrets.yaml，请复制 secrets.template.yaml 并填入真实值${NC}"
  exit 1
fi
kubectl apply -f secrets.yaml

mkdir -p rendered

render_template() {
  local src="$1"
  local dst="$2"

  cp "$src" "$dst"

  python - "$dst" "$IMAGE_PULL_SECRET" "$GATEWAY_HOSTNAMES" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
secret = sys.argv[2]
hostnames = [value.strip().lower() for value in sys.argv[3].split(",") if value.strip()]
text = path.read_text()
secret_placeholder = "__IMAGE_PULL_SECRETS_BLOCK__\n"
if secret_placeholder in text:
    replacement = ""
    if secret:
        replacement = f"      imagePullSecrets:\n        - name: {secret}\n"
    text = text.replace(secret_placeholder, replacement)
hostnames_placeholder = "__HOSTNAMES_BLOCK__\n"
if hostnames_placeholder in text:
    if not hostnames:
        raise SystemExit("At least one gateway hostname is required")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or ".." in host for host in hostnames):
        raise SystemExit("Invalid gateway hostname")
    text = text.replace(hostnames_placeholder, "".join(f'    - "{host}"\n' for host in dict.fromkeys(hostnames)))
path.write_text(text)
PY

  sed -i.bak \
    -e "s|__NAMESPACE__|${NAMESPACE}|g" \
    -e "s|__APP_NAME__|${APP_NAME}|g" \
    -e "s|__IMAGE_REPOSITORY__|${IMAGE_REPOSITORY}|g" \
    -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
    -e "s|__IMAGE_PULL_POLICY__|${IMAGE_PULL_POLICY}|g" \
    -e "s|__SERVICE_PORT__|${SERVICE_PORT}|g" \
    -e "s|__CONTAINER_PORT__|${CONTAINER_PORT}|g" \
    -e "s|__REPLICAS__|${REPLICAS}|g" \
    -e "s|__TERMINATION_GRACE_PERIOD_SECONDS__|${TERMINATION_GRACE_PERIOD_SECONDS}|g" \
    -e "s|__REQUEST_CPU__|${REQUEST_CPU}|g" \
    -e "s|__REQUEST_MEMORY__|${REQUEST_MEMORY}|g" \
    -e "s|__LIMIT_CPU__|${LIMIT_CPU}|g" \
    -e "s|__LIMIT_MEMORY__|${LIMIT_MEMORY}|g" \
    -e "s|__LIVENESS_PATH__|${LIVENESS_PATH}|g" \
    -e "s|__LIVENESS_INITIAL_DELAY__|${LIVENESS_INITIAL_DELAY}|g" \
    -e "s|__LIVENESS_PERIOD__|${LIVENESS_PERIOD}|g" \
    -e "s|__LIVENESS_TIMEOUT__|${LIVENESS_TIMEOUT}|g" \
    -e "s|__LIVENESS_FAILURE_THRESHOLD__|${LIVENESS_FAILURE_THRESHOLD}|g" \
    -e "s|__READINESS_PATH__|${READINESS_PATH}|g" \
    -e "s|__READINESS_INITIAL_DELAY__|${READINESS_INITIAL_DELAY}|g" \
    -e "s|__READINESS_PERIOD__|${READINESS_PERIOD}|g" \
    -e "s|__READINESS_TIMEOUT__|${READINESS_TIMEOUT}|g" \
    -e "s|__READINESS_FAILURE_THRESHOLD__|${READINESS_FAILURE_THRESHOLD}|g" \
    -e "s|__API_BASE_URL__|${API_BASE_URL}|g" \
    -e "s|__LOGTO_ENDPOINT__|${LOGTO_ENDPOINT}|g" \
    -e "s|__ENV__|${ENV}|g" \
    -e "s|__LOG_LEVEL__|${LOG_LEVEL:-info}|g" \
    "$dst"
  rm -f "$dst.bak"
}

render_template "$MANIFESTS_DIR/configmap.tmpl.yaml" rendered/configmap.yaml
render_template "$MANIFESTS_DIR/statefulset.tmpl.yaml" rendered/statefulset.yaml
render_template "$MANIFESTS_DIR/service.tmpl.yaml" rendered/service.yaml
render_template "$MANIFESTS_DIR/relay-service.tmpl.yaml" rendered/relay-service.yaml

kubectl apply -f rendered/configmap.yaml
kubectl apply -f rendered/service.yaml
kubectl apply -f rendered/relay-service.yaml
kubectl apply -f rendered/statefulset.yaml

if [ "$ROUTE_ENABLED" = "true" ]; then
  render_template "$MANIFESTS_DIR/httproute.tmpl.yaml" rendered/httproute.yaml
  kubectl apply -f rendered/httproute.yaml
fi

echo ""
echo -e "${GREEN}✅ Prod 环境部署完成${NC}"
echo ""
echo "查看状态："
echo "  kubectl get pods -n ${NAMESPACE} -l app.kubernetes.io/name=${APP_NAME}"
echo "  kubectl logs -n ${NAMESPACE} -l app.kubernetes.io/name=${APP_NAME} -f"
