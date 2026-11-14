#!/usr/bin/env bash
# Verifies the demo-panel path end to end without changing anything (all scale calls are --dry-run=server):
#   1. RBAC: SA filegrid/filegrid-backend may scale the three storage StatefulSets and nothing broader;
#   2. admission: as that SA, replicas 0 and 1 pass, replicas 2 is denied by the ValidatingAdmissionPolicy;
#   3. token: the running backend pod has the SA token mounted (automountServiceAccountToken: true on the pod),
#      otherwise every API call from the demo panel is unauthenticated. Skipped if no backend pod exists yet.
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

pod=$(kubectl -n filegrid get pods -l app=filegrid-backend -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [ -z "$pod" ]; then
  echo "SKIP  no backend pod in ns filegrid yet (token check runs once the app is deployed)"
else
  mounts=$(kubectl -n filegrid get pod "$pod" -o jsonpath='{.spec.containers[*].volumeMounts[*].mountPath}')
  case " $mounts " in
    *" /var/run/secrets/kubernetes.io/serviceaccount "*) ok "backend pod $pod has the SA token mounted" ;;
    *) bad "backend pod $pod has NO SA token: set automountServiceAccountToken: true in the backend pod spec" ;;
  esac
fi

[ "$fail" -eq 0 ] && echo "demo RBAC: all checks passed" || echo "demo RBAC: FAILED"
exit "$fail"
