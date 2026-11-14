#!/usr/bin/env bash
# Creates Secret filegrid-app-secrets in namespace filegrid once, with random values; re-runs keep it (no rotation,
# so encrypted documents stay readable and issued JWTs stay valid). Values are never printed or put on a command
# line (they go through 0600 temp files).
#   FILEGRID_KEK     base64 of 32 random bytes: AES-256 key-encryption key for connection documents
#   FILEGRID_KEK_ID  k1 (id stored next to each wrapped data key, so the KEK can be rotated later)
#   JWT_SECRET, METER_API_KEY, ADMIN_PASSWORD  random; ADMIN_USERNAME=admin
#   DEMO_USERS_PASSWORD  random (24 chars): the per-role demo accounts (teren, dispecerat, racordari, auditor), so
#                    they never share the admin password. A Secret created before this key existed gets only this
#                    key added; every other key keeps its value.
# Read the passwords with:
#   kubectl -n filegrid get secret filegrid-app-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d
#   kubectl -n filegrid get secret filegrid-app-secrets -o jsonpath='{.data.DEMO_USERS_PASSWORD}' | base64 -d
set -euo pipefail

NS=filegrid
NAME=filegrid-app-secrets

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" --save-config >/dev/null

rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if kubectl -n "$NS" get secret "$NAME" >/dev/null 2>&1; then
  if kubectl -n "$NS" get secret "$NAME" -o json | jq -e '(.data.DEMO_USERS_PASSWORD // "") != ""' >/dev/null; then
    echo "secret $NS/$NAME exists, keeping it"
    exit 0
  fi
  demo_password=$(rand 24)
  [ "${#demo_password}" -eq 24 ] || { echo "random secret generation failed" >&2; exit 1; }
  # JSON merge patch from a 0600 file: adds this one key, the others are left exactly as they are.
  jq -n --arg v "$(printf '%s' "$demo_password" | base64 -w0)" '{data: {DEMO_USERS_PASSWORD: $v}}' > "$tmp/patch.json"
  kubectl -n "$NS" patch secret "$NAME" --type merge --patch-file "$tmp/patch.json" >/dev/null
  echo "secret $NS/$NAME exists, added DEMO_USERS_PASSWORD (other keys unchanged)"
  exit 0
fi

# Generated into variables first: a failing $(...) inside the heredoc would not stop the script (set -e).
kek=$(openssl rand -base64 32 | tr -d '\n')
jwt_secret=$(rand 48); meter_api_key=$(rand 32); admin_password=$(rand 20); demo_password=$(rand 24)
[ "$(printf '%s' "$kek" | base64 -d | wc -c)" -eq 32 ] || { echo "KEK generation failed" >&2; exit 1; }
[ "${#jwt_secret}" -eq 48 ] && [ "${#meter_api_key}" -eq 32 ] && [ "${#admin_password}" -eq 20 ] \
  && [ "${#demo_password}" -eq 24 ] || { echo "random secret generation failed" >&2; exit 1; }

cat > "$tmp/env" <<ENV
FILEGRID_KEK=$kek
FILEGRID_KEK_ID=k1
JWT_SECRET=$jwt_secret
METER_API_KEY=$meter_api_key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$admin_password
DEMO_USERS_PASSWORD=$demo_password
ENV
kubectl -n "$NS" create secret generic "$NAME" --from-env-file="$tmp/env" >/dev/null
echo "secret $NS/$NAME created"
