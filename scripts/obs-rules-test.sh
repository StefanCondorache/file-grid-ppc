#!/usr/bin/env bash
# Checks the alert rules BEFORE they are deployed (make obs-rules-test; make obs-rules-check checks the deployed ones
# inside the Prometheus pod): extracts serverFiles."alerting_rules.yml" from prometheus-values.yaml next to the
# promtool unit tests (deploy/k8s/observability/alerting-rules.test.yml), then runs
#   promtool check rules   and   promtool test rules
# promtool: $PROMTOOL, else `promtool` on PATH, else the image of the deployed Prometheus through docker.
# The YAML is parsed offline by `kubectl annotate --local` (no cluster needed).
set -euo pipefail
cd "$(dirname "$0")/.."

OBS=deploy/k8s/observability
PROM_IMAGE=quay.io/prometheus/prometheus:v3.16.0   # appVersion of chart prometheus 29.47.2 (mk/observability.mk)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

{ printf 'apiVersion: test.filegrid.io/v1\nkind: Values\nmetadata: {name: v}\nvalues:\n'; sed 's/^/  /' "$OBS/prometheus-values.yaml"; } \
  | KUBECONFIG=/dev/null kubectl annotate --local -f - x=y -o json \
  | jq -e '.values.serverFiles["alerting_rules.yml"]' > "$tmp/alerting_rules.yml"
cp "$OBS/alerting-rules.test.yml" "$tmp/"

if [ -n "${PROMTOOL:-}" ]; then promtool=("$PROMTOOL")
elif command -v promtool >/dev/null 2>&1; then promtool=(promtool)
elif command -v docker >/dev/null 2>&1; then
  promtool=(docker run --rm -u "$(id -u)" -v "$tmp:/rules:ro" -w /rules --entrypoint promtool "$PROM_IMAGE")
else
  echo "promtool not found (set PROMTOOL, install promtool, or install docker)" >&2; exit 1
fi
cd "$tmp"
"${promtool[@]}" check rules alerting_rules.yml
"${promtool[@]}" test rules alerting-rules.test.yml
