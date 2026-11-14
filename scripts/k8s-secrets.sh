#!/usr/bin/env bash
# Creates Secret filegrid-storage-credentials in namespace filegrid-storage (only if missing, so re-runs never
# rotate credentials) and mirrors it, with identical data, into namespace filegrid for the app pods.
# Secret values are never printed, passed on a command line or written to a file.
set -euo pipefail

SRC_NS=filegrid-storage
DST_NS=filegrid
NAME=filegrid-storage-credentials
KEYS=(POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET FTP_USER FTP_PASSWORD)

# Create the namespaces only when missing: their manifests (deploy/k8s) own them, and re-applying a different
# manifest here would rewrite their last-applied annotation on every run (no longer a no-op).
for ns in "$SRC_NS" "$DST_NS"; do
  kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns" --save-config >/dev/null
done

rand() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | cut -c1-24; }

if kubectl -n "$SRC_NS" get secret "$NAME" >/dev/null 2>&1; then
  # Kept as is, but only if every key is there and not empty (prints key names, never values).
  bad=$(kubectl -n "$SRC_NS" get secret "$NAME" -o json \
    | jq -r '.data as $d | $ARGS.positional[] | select(((($d // {})[.] // "") | @base64d) == "")' --args "${KEYS[@]}")
  if [ -n "$bad" ]; then
    echo "error: secret $SRC_NS/$NAME is missing or has empty keys: ${bad//$'\n'/ }" >&2
    exit 1
  fi
  echo "secret $SRC_NS/$NAME exists with all ${#KEYS[@]} keys, keeping it"
else
  # Postgres keeps the password it was initialised with in its volume: new credentials would lock everyone out.
  if kubectl -n "$SRC_NS" get pvc data-postgres-0 >/dev/null 2>&1; then
    echo "error: secret $SRC_NS/$NAME is missing but PVC $SRC_NS/data-postgres-0 exists;" \
      "Postgres would keep its old password, so no new credentials are generated." >&2
    echo "Restore the Secret with its old values, or, to start with empty storages on purpose:" \
      "kubectl -n $SRC_NS delete statefulset postgres s3 ftp && kubectl -n $SRC_NS delete pvc --all" >&2
    exit 1
  fi
  # Generated into variables first: a failing $(rand) inside the heredoc would not stop the script (set -e).
  pg_password=$(rand); s3_access_key=$(rand); s3_secret_key=$(rand); ftp_password=$(rand)
  for v in "$pg_password" "$s3_access_key" "$s3_secret_key" "$ftp_password"; do
    [ "${#v}" -eq 24 ] || { echo "random secret generation failed" >&2; exit 1; }
  done
  # Straight from the heredoc (a pipe) to kubectl: no temporary file with the values on disk.
  kubectl -n "$SRC_NS" create secret generic "$NAME" --from-env-file=/dev/stdin >/dev/null <<ENV
POSTGRES_DB=filegrid
POSTGRES_USER=filegrid
POSTGRES_PASSWORD=$pg_password
S3_ACCESS_KEY=$s3_access_key
S3_SECRET_KEY=$s3_secret_key
S3_BUCKET=filegrid
FTP_USER=filegrid
FTP_PASSWORD=$ftp_password
ENV
  echo "secret $SRC_NS/$NAME created"
fi

# Mirror into the app namespace (create-or-update, same data). Server-side apply: unlike client-side apply it
# stores no last-applied-configuration annotation, which would hold a second copy of every value.
kubectl -n "$SRC_NS" get secret "$NAME" -o json \
  | jq --arg ns "$DST_NS" '{apiVersion: "v1", kind: "Secret", type: .type,
      metadata: {name: .metadata.name, namespace: $ns, labels: {"app.kubernetes.io/managed-by": "k8s-secrets.sh"}},
      data: .data}' \
  | kubectl apply --server-side --field-manager=k8s-secrets --force-conflicts -f - >/dev/null
# Mirrors made by the earlier client-side apply carried that annotation. kubectl's switch to server-side apply
# normally removes it (seen on the VPS); this drops any copy that is still there.
if kubectl -n "$DST_NS" get secret "$NAME" -o json \
    | jq -e '.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] != null' >/dev/null; then
  kubectl -n "$DST_NS" annotate secret "$NAME" kubectl.kubernetes.io/last-applied-configuration- >/dev/null
  echo "removed the last-applied-configuration annotation from $DST_NS/$NAME"
fi
echo "secret $DST_NS/$NAME in sync"
