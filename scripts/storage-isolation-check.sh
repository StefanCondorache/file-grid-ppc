#!/usr/bin/env bash
# Proves the NetworkPolicies: short-lived pinned pods try to open TCP connections to postgres, s3 and ftp
# (control port and a passive data port on the ftp pod IP). Prints a PASS/FAIL table, exits 1 on any
# unexpected result, always deletes its pods.
set -uo pipefail

IMAGE=postgres:17.12-alpine   # pinned; busybox nc is enough for a TCP connect test
STORE=filegrid-storage
RUN=$$
PODS=()
FAIL=0

cleanup() {
  for p in "${PODS[@]}"; do kubectl -n "${p%%/*}" delete pod "${p##*/}" --force --grace-period=0 --wait=false >/dev/null 2>&1; done
}
trap cleanup EXIT

FTP_IP=$(kubectl -n "$STORE" get pod ftp-0 -o jsonpath='{.status.podIP}')
[ -n "$FTP_IP" ] || { echo "ftp-0 pod IP not found"; exit 1; }

# name  host  port
TARGETS=(
  "postgres|postgres.$STORE.svc.cluster.local|5432"
  "s3|s3.$STORE.svc.cluster.local|8333"
  "ftp (21)|ftp.$STORE.svc.cluster.local|21"
  "ftp passive (21000)|$FTP_IP|21000"
)

# client_case <label> <namespace> <extra label or ""> <expected: open|blocked>
client_case() {
  local label=$1 ns=$2 lbl=$3 expect=$4 name="isocheck-$RUN-$5"
  local labels="app=isocheck"; [ -n "$lbl" ] && labels="$labels,$lbl"
  kubectl -n "$ns" run "$name" --image="$IMAGE" --restart=Never --labels="$labels" \
    --command -- sleep 120 >/dev/null 2>&1
  PODS+=("$ns/$name")
  if ! kubectl -n "$ns" wait --for=condition=Ready "pod/$name" --timeout=90s >/dev/null 2>&1; then
    echo "client pod $ns/$name did not become Ready"; FAIL=1; return
  fi
  local t host port tname res verdict
  for t in "${TARGETS[@]}"; do
    IFS='|' read -r tname host port <<<"$t"
    # A policy-blocked port fails only after ~1s; a reachable but idle port (passive range with no transfer
    # running) is refused instantly. So: connected, or failed in <0.5s (read from /proc/uptime) = reachable.
    res=$(kubectl -n "$ns" exec "$name" -- sh -c 'u() { cut -d" " -f1 /proc/uptime; }; s=$(u)
      if nc -z -w 3 "$0" "$1"; then echo open; else
      awk -v a="$s" -v b="$(u)" "BEGIN{print (b-a<0.5) ? \"open\" : \"blocked\"}"; fi' "$host" "$port" 2>/dev/null || echo blocked)
    verdict=PASS; [ "$res" = "$expect" ] || { verdict=FAIL; FAIL=1; }
    printf '%-34s %-20s %-8s %-8s %s\n' "$label" "$tname" "$expect" "$res" "$verdict"
  done
}

printf '%-34s %-20s %-8s %-8s %s\n' CLIENT TARGET EXPECTED ACTUAL RESULT
client_case "filegrid, labeled"     filegrid 'filegrid.io/storage-client=true' open    a
client_case "filegrid, unlabeled"   filegrid ''                                blocked b
client_case "default namespace"     default  ''                                blocked c

if [ "$FAIL" -eq 0 ]; then echo "ISOLATION OK"; else echo "ISOLATION CHECK FAILED"; fi
exit "$FAIL"
