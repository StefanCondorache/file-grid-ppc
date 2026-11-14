#!/usr/bin/env bash
# helm upgrade --install of one observability release (make obs-up), skipped when nothing changed, so a repeated
# `make up` creates no new helm revision and touches no object:
#   obs-helm.sh <release> <namespace> <repo/chart> <version> <values file> [extra helm args...]
# The checksum covers the chart, version, namespace, extra args (e.g. --set-string with DOMAIN) and the values file
# contents. It is recorded in ConfigMap monitoring/obs-helm-checksums (key <namespace>.<release>) only after a
# successful upgrade. helm runs when the checksum differs, when the release is not deployed with exactly
# <chart>-<version> (failed, uninstalled, rolled back to another chart), or with OBS_HELM_FORCE=1.
# To force a single release: kubectl -n monitoring patch configmap obs-helm-checksums --type json \
#   -p '[{"op":"remove","path":"/data/monitoring.grafana"}]'
set -euo pipefail
[ $# -ge 5 ] || { echo "usage: $0 <release> <namespace> <repo/chart> <version> <values file> [helm args...]" >&2; exit 2; }
release=$1 ns=$2 chart=$3 version=$4 values=$5
shift 5

CM_NS=monitoring
CM=obs-helm-checksums
key=$ns.$release
chart_version=${chart#*/}-$version

sum=$({ printf '%s\n' "$chart" "$version" "$ns" "$@" '--- values'; cat "$values"; } | sha256sum | cut -d' ' -f1)
recorded=$(kubectl -n "$CM_NS" get configmap "$CM" -o json 2>/dev/null | jq -r --arg k "$key" '.data[$k] // ""' || true)
deployed=$(helm -n "$ns" list --deployed -f "^$release\$" -o json | jq -r '.[0].chart // ""')

if [ "${OBS_HELM_FORCE:-0}" != 1 ] && [ "$recorded" = "$sum" ] && [ "$deployed" = "$chart_version" ]; then
  echo "$release: $chart_version deployed with unchanged values (checksum ${sum:0:12}); skipping helm upgrade"
  exit 0
fi

echo "$release: helm upgrade --install $chart_version (deployed: ${deployed:-none}; values checksum ${sum:0:12})"
helm upgrade --install "$release" "$chart" --version "$version" -n "$ns" -f "$values" --wait --timeout 4m "$@"
kubectl -n "$CM_NS" get configmap "$CM" >/dev/null 2>&1 || kubectl -n "$CM_NS" create configmap "$CM" >/dev/null
kubectl -n "$CM_NS" patch configmap "$CM" --type merge -p "{\"data\":{\"$key\":\"$sum\"}}" >/dev/null
