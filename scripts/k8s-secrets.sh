#!/usr/bin/env bash
# Creates Secret filegrid-storage-credentials in namespace filegrid-storage (only if missing, so re-runs never
# rotate credentials) and mirrors it, with identical data, into namespace filegrid for the app pods.
# Secret values are never printed or passed on a command line.
set -euo pipefail

SRC_NS=filegrid-storage
DST_NS=filegrid
NAME=filegrid-storage-credentials

# Create the namespaces only when missing: their manifests (deploy/k8s) own them, and re-applying a different
# manifest here would rewrite their last-applied annotation on every run (no longer a no-op).
for ns in "$SRC_NS" "$DST_NS"; do
  kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns" --save-config >/dev/null
done

rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-24; }

if kubectl -n "$SRC_NS" get secret "$NAME" >/dev/null 2>&1; then
  echo "secret $SRC_NS/$NAME exists, keeping it"
else
  # Generated into variables first: a failing $(rand) inside the heredoc would not stop the script (set -e).
  pg_password=$(rand); s3_access_key=$(rand); s3_secret_key=$(rand); ftp_password=$(rand)
  for v in "$pg_password" "$s3_access_key" "$s3_secret_key" "$ftp_password"; do
    [ "${#v}" -eq 24 ] || { echo "random secret generation failed" >&2; exit 1; }
  done
  umask 077
  envfile=$(mktemp)
  trap 'rm -f "$envfile"' EXIT
  cat > "$envfile" <<ENV
POSTGRES_DB=filegrid
POSTGRES_USER=filegrid
POSTGRES_PASSWORD=$pg_password
S3_ACCESS_KEY=$s3_access_key
S3_SECRET_KEY=$s3_secret_key
S3_BUCKET=filegrid
FTP_USER=filegrid
FTP_PASSWORD=$ftp_password
ENV
  kubectl -n "$SRC_NS" create secret generic "$NAME" --from-env-file="$envfile" >/dev/null
  echo "secret $SRC_NS/$NAME created"
fi

# Mirror into the app namespace (create-or-update, same data).
kubectl -n "$SRC_NS" get secret "$NAME" -o json \
  | jq --arg ns "$DST_NS" '{apiVersion:"v1",kind:"Secret",type:.type,metadata:{name:.metadata.name,namespace:$ns},data:.data}' \
  | kubectl apply -f - >/dev/null
echo "secret $DST_NS/$NAME in sync"
