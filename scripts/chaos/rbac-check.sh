#!/usr/bin/env bash
# Verifies the demo-panel path end to end without changing anything (all scale calls are --dry-run=server):
#   1. RBAC: SA filegrid/filegrid-backend may scale the three storage StatefulSets and nothing broader;
#   2. admission: as that SA, replicas 0 and 1 pass, replicas 2 is denied by the ValidatingAdmissionPolicy;
#   3. token: the backend Deployment's pod spec mounts the SA token (automountServiceAccountToken: true),
#      otherwise every API call from the demo panel is unauthenticated (401). Skipped if not deployed yet.
# Exit 0 only if every check holds.
set -uo pipefail

SA=system:serviceaccount:filegrid:filegrid-backend
NS=filegrid-storage
fail=0
ok()  { echo "OK    $*"; }
bad() { echo "FAIL  $*"; fail=1; }

expect_can() {  # expect_can yes|no <can-i args...>
  local want=$1; shift
  local got; got=$(kubectl auth can-i --as="$SA" "$@" 2>/dev/null)
  [ "$got" = "$want" ] && ok "can-i $* = $got" || bad "can-i $* = ${got:-error} (want $want)"
}
expect_can yes patch statefulsets/s3 --subresource=scale -n "$NS"
expect_can yes patch statefulsets/postgres --subresource=scale -n "$NS"
expect_can yes patch statefulsets/ftp --subresource=scale -n "$NS"
expect_can no  delete statefulsets/s3 -n "$NS"
expect_can no  patch statefulsets/s3 -n "$NS"
expect_can no  get secrets -n "$NS"

for r in 0 1; do
  if out=$(kubectl --as="$SA" -n "$NS" scale statefulset s3 --replicas="$r" --dry-run=server 2>&1); then
    ok "SA scale s3 --replicas=$r allowed: $out"
  else
    bad "SA scale s3 --replicas=$r rejected: $out"
  fi
done
if out=$(kubectl --as="$SA" -n "$NS" scale statefulset s3 --replicas=2 --dry-run=server 2>&1); then
  bad "SA scale s3 --replicas=2 was allowed (admission policy missing?): $out"
else
  case "$out" in
    *filegrid-demo-storage-scale-0-or-1*) ok "SA scale s3 --replicas=2 denied: $out" ;;
    *) bad "SA scale s3 --replicas=2 failed for another reason: $out" ;;
  esac
fi

# The Deployment template, not "some pod labelled app=filegrid-backend": bare test pods may carry that label.
# The SA itself has automountServiceAccountToken: false, so the pod spec must opt in explicitly.
if ! kubectl -n filegrid get deploy filegrid-backend >/dev/null 2>&1; then
  echo "SKIP  no Deployment filegrid/filegrid-backend yet (token check runs once the app is deployed)"
else
  tok=$(kubectl -n filegrid get deploy filegrid-backend -o jsonpath='{.spec.template.spec.automountServiceAccountToken}')
  [ "$tok" = "true" ] && ok "Deployment filegrid-backend mounts the SA token (automountServiceAccountToken: true)" \
    || bad "Deployment filegrid-backend has no SA token (automountServiceAccountToken='${tok}'): set it to true in the pod spec"
fi

[ "$fail" -eq 0 ] && echo "demo RBAC: all checks passed" || echo "demo RBAC: FAILED"
exit "$fail"
