#!/usr/bin/env bash
# Demo chaos: stop / start one storage by scaling its StatefulSet in namespace filegrid-storage to 0 / 1.
#   scripts/chaos/storage.sh stop   <postgres|s3|ftp>   scale to 0, wait until the pod is gone
#   scripts/chaos/storage.sh start  <postgres|s3|ftp>   scale to 1, wait until the pod is Ready
#   scripts/chaos/storage.sh status [postgres|s3|ftp]   replicas / ready / pod phase
# DRY_RUN=1 sends the scale with --dry-run=server (validated + authorized by the API server, nothing changes)
# and skips the wait. The data survives a stop: the PVC stays, only the pod goes away.
# The backend demo panel does the same scale through the API (deploy/k8s/demo-rbac.yaml); this is the CLI twin.
set -euo pipefail

NS=${CHAOS_STORAGE_NS:-filegrid-storage}
TIMEOUT=${CHAOS_TIMEOUT:-180s}
DRY_RUN=${DRY_RUN:-0}
STORAGES="postgres s3 ftp"

usage() { echo "usage: $0 stop|start|status <postgres|s3|ftp>   (DRY_RUN=1 for a server-side dry run)" >&2; exit 2; }

# Only the three known names; anything else (typos, other StatefulSets, injection) is rejected.
valid() { case "$1" in postgres|s3|ftp) return 0 ;; *) return 1 ;; esac; }

# Storage label used by the metrics contract (filegrid_storage_up{storage=...}).
metric_label() { case "$1" in postgres) echo db ;; *) echo "$1" ;; esac; }

status_one() {
  local s=$1 spec ready pod
  spec=$(kubectl -n "$NS" get statefulset "$s" -o jsonpath='{.spec.replicas}')
  ready=$(kubectl -n "$NS" get statefulset "$s" -o jsonpath='{.status.readyReplicas}')
  pod=$(kubectl -n "$NS" get pod "$s-0" -o jsonpath='{.status.phase}' 2>/dev/null || echo absent)
  local state=UP
  [ "${spec:-0}" = 0 ] && state=STOPPED
  [ "${spec:-0}" != 0 ] && [ "${ready:-0}" != "$spec" ] && state=STARTING
  printf '%-9s %-8s replicas=%s ready=%s pod=%s-0:%s\n' "$s" "$state" "${spec:-0}" "${ready:-0}" "$s" "$pod"
}

scale() {
  local s=$1 n=$2
  if [ "$DRY_RUN" = 1 ]; then
    kubectl -n "$NS" scale statefulset "$s" --replicas="$n" --dry-run=server
    echo "DRY_RUN=1: nothing changed, no wait"
    exit 0
  fi
  kubectl -n "$NS" scale statefulset "$s" --replicas="$n"
}

cmd=${1:-}; name=${2:-}
case "$cmd" in
  status)
    if [ -n "$name" ]; then valid "$name" || usage; status_one "$name"
    else for s in $STORAGES; do status_one "$s"; done; fi
    ;;
  stop)
    valid "$name" || usage
    scale "$name" 0
    echo "waiting up to $TIMEOUT for pod $name-0 to terminate..."
    kubectl -n "$NS" wait --for=delete "pod/$name-0" --timeout="$TIMEOUT"
    status_one "$name"
    cat <<MSG

Storage '$name' is DOWN. What the jury should observe:
  - Grafana: filegrid_storage_up{storage="$(metric_label "$name")"} = 0, circuit state goes to OPEN (2),
    errors for this storage rise; requests to it fail fast (no hanging uploads).
  - Categories whose policy uses '$name' fail fast or switch to their fallback storage.
  - Every other category keeps uploading and downloading normally (bulkhead + per-storage circuit breaker),
    and /readyz of the backend stays ready.
Bring it back: make chaos-storage-start S=$name
MSG
    ;;
  start)
    valid "$name" || usage
    scale "$name" 1
    echo "waiting up to $TIMEOUT for $name to be Ready..."
    kubectl -n "$NS" rollout status "statefulset/$name" --timeout="$TIMEOUT"
    status_one "$name"
    cat <<MSG

Storage '$name' is UP again. What the jury should observe:
  - filegrid_storage_up{storage="$(metric_label "$name")"} = 1, circuit goes HALF-OPEN (1) then CLOSED (0).
  - New operations for its categories succeed again; files written before the stop are still there (PVC kept).
MSG
    ;;
  *) usage ;;
esac
