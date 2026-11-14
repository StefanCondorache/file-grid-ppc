#!/usr/bin/env bash
# Deploys exactly the FileGrid app components whose image exists in k3s containerd (built by k8s-app-images.sh):
# filegrid-backend, filegrid-frontend, filegrid-simulator at tag $APP_TAG (default git short sha; per component
# BACKEND_TAG / FRONTEND_TAG / SIMULATOR_TAG). Components without an image are removed, so the cluster always
# matches what was built. With --down every component is removed.
#
# "/" routing: while the frontend runs, Ingress filegrid-frontend serves "/" and owns the TLS certificate and the
# placeholder (deploy/k8s/placeholder.yaml) is deleted; without a frontend the placeholder is (re)applied and owns
# them again. /api (Ingress filegrid-api) is independent of that switch.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=filegrid
APP_DIR=deploy/k8s/app
CERT=ppc-filegrid-tls
DOMAIN=${DOMAIN:-ppc.filegrid.cc.cd}
METER_RATE=${METER_RATE:-10}
TAG=${APP_TAG:-$(git rev-parse --short HEAD)}
DOWN=0
[ "${1:-}" = "--down" ] && DOWN=1

printf '%s\n' "$DOMAIN" | grep -Eqx '[a-z0-9]([a-z0-9.-]*[a-z0-9])?' || { echo "invalid DOMAIN: $DOMAIN" >&2; exit 1; }
printf '%s\n' "$METER_RATE" | grep -Eqx '[A-Za-z0-9._-]+' || { echo "invalid METER_RATE: $METER_RATE" >&2; exit 1; }

tag_of() {
  case $1 in
    backend) echo "${BACKEND_TAG:-$TAG}" ;;
    frontend) echo "${FRONTEND_TAG:-$TAG}" ;;
    simulator) echo "${SIMULATOR_TAG:-$TAG}" ;;
  esac
}

images=$(k3s ctr -n k8s.io images ls -q 2>/dev/null || true)
present=()
absent=()
for c in backend frontend simulator; do
  t=$(tag_of "$c")
  printf '%s\n' "$t" | grep -Eqx '[A-Za-z0-9_.-]+' || { echo "invalid tag for $c: $t" >&2; exit 1; }
  if [ "$DOWN" -eq 0 ] && grep -qxF "docker.io/library/filegrid-$c:$t" <<<"$images"; then
    present+=("$c")
    echo "deploy filegrid-$c:$t"
  else
    absent+=("$c")
    [ "$DOWN" -eq 1 ] || echo "skip filegrid-$c: image filegrid-$c:$t not in k3s (no $c/Dockerfile built)"
  fi
done

# Points ingress-shim at the Ingress that now serves "/": when the previous owner Ingress was deleted, its
# Certificate is garbage collected; touching the new owner makes cert-manager recreate the Certificate, which
# adopts the existing (still valid) secret instead of requesting a new one.
cert_owner() {
  local ing=$1 owner
  owner=$(kubectl -n "$NS" get certificate "$CERT" -o jsonpath='{.metadata.ownerReferences[0].name}' 2>/dev/null || true)
  [ "$owner" = "$ing" ] && return 0
  kubectl -n "$NS" wait --for=delete "certificate/$CERT" --timeout=60s >/dev/null 2>&1 || true
  kubectl -n "$NS" annotate ingress "$ing" filegrid.io/cert-resync="$(date +%s)" --overwrite >/dev/null
  for _ in $(seq 30); do
    kubectl -n "$NS" get certificate "$CERT" >/dev/null 2>&1 && break
    sleep 2
  done
  kubectl -n "$NS" wait --for=condition=Ready "certificate/$CERT" --timeout=180s
}

is_present() { local x; for x in "${present[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

if ! is_present frontend; then
  # Bring the placeholder back before the frontend Ingress goes, so "/" never 404s.
  sed "s/ppc\.filegrid\.cc\.cd/$DOMAIN/g" deploy/k8s/placeholder.yaml | kubectl apply -f -
  kubectl -n "$NS" rollout status deploy/placeholder --timeout=120s
fi

for c in "${absent[@]}"; do
  kubectl -n "$NS" delete deploy,svc,hpa,ingress,configmap \
    -l "app.kubernetes.io/part-of=filegrid-app,app.kubernetes.io/component=$c" --ignore-not-found
done
if [ "$DOWN" -eq 1 ]; then
  kubectl -n "$NS" delete serviceaccount filegrid-backend --ignore-not-found
fi

if [ "$DOWN" -eq 0 ]; then
  # Temporary overlay next to the components (kustomize only accepts relative resource paths).
  render=$(mktemp -d "$APP_DIR/.render.XXXXXX")
  trap 'rm -rf "$render"' EXIT
  {
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "resources:"
    echo "  - ../base"
    for c in "${present[@]}"; do echo "  - ../$c"; done
    if [ "${#present[@]}" -gt 0 ]; then
      echo "images:"
      for c in "${present[@]}"; do echo "  - {name: filegrid-$c, newTag: \"$(tag_of "$c")\"}"; done
    fi
    if is_present simulator; then
      echo "configMapGenerator:"
      echo "  - {name: filegrid-simulator-config, behavior: merge, literals: [\"METER_RATE=$METER_RATE\"]}"
    fi
  } > "$render/kustomization.yaml"
  kubectl kustomize "$render" | sed "s/ppc\.filegrid\.cc\.cd/$DOMAIN/g" | kubectl apply -f -
  for c in "${present[@]}"; do
    kubectl -n "$NS" rollout status "deploy/filegrid-$c" --timeout=180s
  done
fi

if is_present frontend; then
  kubectl -n "$NS" delete ingress/placeholder deploy/placeholder svc/placeholder configmap/placeholder-site --ignore-not-found
  cert_owner filegrid-frontend
else
  cert_owner placeholder
fi
