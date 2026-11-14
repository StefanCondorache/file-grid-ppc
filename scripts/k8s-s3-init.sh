#!/usr/bin/env bash
# Runs the one-shot Job s3-init (creates the bucket; idempotent itself) unless an identical s3-init Job already
# completed after the current S3 volume was created, so a repeated `make up` starts no pod. A finished Job's pod
# template is immutable, hence delete + apply whenever it has to run again.
set -euo pipefail
export LC_ALL=C   # plain byte order for the RFC 3339 timestamp comparison below

NS=filegrid-storage
JOB_FILE=deploy/k8s/storage/s3-init-job.yaml

completed=$(kubectl -n "$NS" get job s3-init -o jsonpath='{.status.completionTime}' 2>/dev/null || true)
volume_created=$(kubectl -n "$NS" get pvc data-s3-0 -o jsonpath='{.metadata.creationTimestamp}')

if [[ -n $completed && $completed > $volume_created ]] && kubectl diff -f "$JOB_FILE" >/dev/null 2>&1; then
  echo "job s3-init already completed for the current S3 volume and is unchanged; not re-running"
  exit 0
fi

kubectl -n "$NS" delete job s3-init --ignore-not-found --wait=true
kubectl apply -f "$JOB_FILE"
kubectl -n "$NS" wait --for=condition=complete job/s3-init --timeout=180s
