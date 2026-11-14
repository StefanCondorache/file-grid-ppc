#!/usr/bin/env bash
# Secretele stack-ului de observabilitate (namespace monitoring), create DOAR daca lipsesc (re-rularea nu le roteste):
#  - grafana-admin: admin-user=admin, admin-password aleator (citit de chart prin admin.existingSecret)
#  - alertmanager-config: alertmanager.yml cu receiver "null" (fara notificari, decizia echipei). Discord/Telegram
#    se adauga editand doar acest Secret (vezi comentariul din deploy/k8s/observability/prometheus-values.yaml).
# Valorile nu sunt afisate si nu apar pe linia de comanda (fisier temporar 0600).
set -euo pipefail
NS=monitoring
kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" --save-config >/dev/null

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if kubectl -n "$NS" get secret grafana-admin >/dev/null 2>&1; then
  echo "secret $NS/grafana-admin exists, keeping it"
else
  pw=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)
  [ "${#pw}" -eq 24 ] || { echo "random password generation failed" >&2; exit 1; }
  printf 'admin' > "$tmp/admin-user"
  printf '%s' "$pw" > "$tmp/admin-password"
  kubectl -n "$NS" create secret generic grafana-admin \
    --from-file=admin-user="$tmp/admin-user" --from-file=admin-password="$tmp/admin-password" >/dev/null
  echo "secret $NS/grafana-admin created"
fi

if kubectl -n "$NS" get secret alertmanager-config >/dev/null 2>&1; then
  echo "secret $NS/alertmanager-config exists, keeping it"
else
  cat > "$tmp/alertmanager.yml" <<'YAML'
global:
  resolve_timeout: 5m
route:
  receiver: "null"
  group_by: [alertname, storage, category]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
receivers:
  - name: "null"
YAML
  kubectl -n "$NS" create secret generic alertmanager-config --from-file=alertmanager.yml="$tmp/alertmanager.yml" >/dev/null
  echo "secret $NS/alertmanager-config created"
fi
