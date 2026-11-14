#!/usr/bin/env bash
# Runs the storage integration tests inside k3s as the Job in k8s-job.yaml:
# build the test image, import it into k3s containerd, (re)create the Job, stream its log, report the
# exit code and the memory peak, then delete the Job.
#
# Usage (as root on the k3s host, from anywhere):
#   backend/app/storage/tests/run-in-cluster.sh
# Optional environment:
#   FILEGRID_TEST_BIG_S3_MB / FILEGRID_TEST_BIG_FTP_MB / FILEGRID_TEST_BIG_DB_MB   sizes of the big
#       streaming tests in MiB (defaults 1024 / 1024 / 256; 0 skips that one)
#   PYTEST_ADDOPTS   extra pytest arguments, e.g. "-k 'not big'"   (no double quotes inside)
#   KEEP_JOB=1       keep the finished Job and its pod for inspection
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$(cd "$here/../../.." && pwd)"
manifest="$here/k8s-job.yaml"
image="filegrid-storage-tests:local"
ns="filegrid"
job="filegrid-storage-tests"

for tool in docker k3s kubectl; do
  command -v "$tool" >/dev/null || { echo "run-in-cluster: $tool is required" >&2; exit 2; }
done
kubectl -n "$ns" get secret filegrid-storage-credentials >/dev/null \
  || { echo "run-in-cluster: Secret filegrid-storage-credentials missing in $ns (run: make k8s-secrets)" >&2; exit 2; }

echo "==> building $image"
docker build -q -f "$here/Dockerfile" -t "$image" "$backend" >/dev/null
echo "==> importing $image into k3s containerd"
docker save "$image" | k3s ctr images import - >/dev/null

sampler_pid=""
peak_file="$(mktemp)"
cleanup() {
  [[ -n "$sampler_pid" ]] && kill "$sampler_pid" 2>/dev/null || true
  rm -f "$peak_file"
  if [[ "${KEEP_JOB:-0}" != "1" ]]; then
    kubectl -n "$ns" delete job "$job" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

kubectl -n "$ns" delete job "$job" --ignore-not-found --wait=true >/dev/null

# Apply the manifest with the optional overrides filled in (only the env lines named below change).
override() {  # $1 = env name, $2 = value or empty to keep the manifest's value
  if [[ -n "$2" ]]; then
    sed -E "s|(\{name: $1, value: )\"[^\"]*\"|\1\"$2\"|"
  else
    cat
  fi
}
override FILEGRID_TEST_BIG_S3_MB "${FILEGRID_TEST_BIG_S3_MB:-}" < "$manifest" \
  | override FILEGRID_TEST_BIG_FTP_MB "${FILEGRID_TEST_BIG_FTP_MB:-}" \
  | override FILEGRID_TEST_BIG_DB_MB "${FILEGRID_TEST_BIG_DB_MB:-}" \
  | override PYTEST_ADDOPTS "${PYTEST_ADDOPTS:-}" \
  | kubectl apply -f - >/dev/null
echo "==> job/$job created in namespace $ns"

pod=""
for _ in $(seq 1 120); do
  pod="$(kubectl -n "$ns" get pod -l job-name="$job" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  phase="$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [[ -n "$pod" && "$phase" != "Pending" && -n "$phase" ]] && break
  sleep 1
done
[[ -n "$pod" ]] || { echo "run-in-cluster: pod did not start" >&2; exit 1; }

# Memory as seen by metrics-server (coarse, ~15 s resolution); the suite prints exact cgroup numbers.
(
  while sleep 5; do
    kubectl -n "$ns" top pod "$pod" --no-headers 2>/dev/null | awk '{print $3}' | tr -d 'Mi' >> "$peak_file" || true
  done
) &
sampler_pid=$!

echo "==> logs of pod/$pod"
kubectl -n "$ns" logs -f "pod/$pod" || true

for _ in $(seq 1 60); do
  code="$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null || true)"
  [[ -n "$code" ]] && break
  sleep 1
done
reason="$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].state.terminated.reason}' 2>/dev/null || true)"
peak="$(sort -n "$peak_file" | tail -1)"
echo "==> pod $pod finished: exit code ${code:-unknown}, reason ${reason:-unknown}, max memory seen by metrics-server ${peak:-n/a}Mi (limit 256Mi)"
[[ "$reason" == "OOMKilled" ]] && { echo "run-in-cluster: OOMKilled: memory is not constant" >&2; exit 1; }
exit "${code:-1}"
