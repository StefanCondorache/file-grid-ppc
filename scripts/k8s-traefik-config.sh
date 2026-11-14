#!/usr/bin/env bash
# Applies deploy/k8s/traefik-config.yaml (HelmChartConfig of the Traefik bundled with k3s) and, only when that
# changed something, waits until k3s's helm-controller has re-run job helm-install-traefik (a new Job, completed)
# and then for the Traefik rollout. Without that wait, `rollout status` could return for the old Traefik while
# the helm-controller has not yet picked up the new values.
set -euo pipefail

NS=kube-system
JOB=helm-install-traefik

job_state() { kubectl -n "$NS" get job "$JOB" -o jsonpath='{.metadata.uid} {.status.completionTime}' 2>/dev/null || true; }

before=$(job_state)
out=$(kubectl apply -f deploy/k8s/traefik-config.yaml)
echo "$out"
case $out in
  *" unchanged") ;;
  *)
    echo "waiting for the k3s helm-controller to re-run job $JOB with the new values"
    old_uid=${before%% *}
    for i in $(seq 90); do
      read -r uid completed <<<"$(job_state)"
      [ -n "${uid:-}" ] && [ "$uid" != "$old_uid" ] && [ -n "${completed:-}" ] && break
      [ "$i" -lt 90 ] || { echo "error: job $JOB did not complete within 180s:" \
        "kubectl -n $NS describe job $JOB; kubectl -n $NS logs job/$JOB" >&2; exit 1; }
      sleep 2
    done
    echo "job $JOB completed" ;;
esac
kubectl -n "$NS" rollout status deploy/traefik --timeout=180s
