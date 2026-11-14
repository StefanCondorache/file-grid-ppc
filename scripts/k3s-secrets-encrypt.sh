#!/usr/bin/env bash
# Kubernetes Secrets encryption at rest in the k3s datastore (k3s's own AES-CBC key), on an existing single-server
# k3s: sudo make k3s-secrets-encrypt. NOT part of `make up`: turning it on restarts k3s (the API is down for about a
# minute; running pods are not restarted). Idempotent, every step only when needed:
#   1. no encryption config (k3s installed without --secrets-encryption, like the current VPS):
#      `secrets-encryption: true` in /etc/rancher/k3s/config.yaml, then systemctl restart k3s;
#      config present but disabled (`k3s secrets-encrypt disable` was run): k3s secrets-encrypt enable + restart.
#      The flag stays in config.yaml, so later restarts and reinstalls keep encryption on.
#   2. stage not yet reencrypt_finished: k3s secrets-encrypt reencrypt --force --skip rewrites every Secret with the
#      active key (Secrets written before step 1 are still plaintext in the datastore until then); waits for it.
#   3. verifies: k3s secrets-encrypt status (Enabled, reencrypt_finished, all hashes match) and, with the default
#      SQLite datastore, that the current row of every Secret starts with k8s:enc: (counts only, values are not
#      read out). Older revisions of a Secret stay in the datastore until kine compacts them (minutes).
# A second run only verifies. Env (tests): K3S_CONFIG, K3S_DATASTORE, K3S_ENCRYPT_POLL (seconds between polls).
set -euo pipefail

K3S_CONFIG=${K3S_CONFIG:-/etc/rancher/k3s/config.yaml}
K3S_DATASTORE=${K3S_DATASTORE:-/var/lib/rancher/k3s/server/db/state.db}
POLL=${K3S_ENCRYPT_POLL:-2}
export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (k3s config, systemctl, datastore): sudo make k3s-secrets-encrypt"
command -v k3s >/dev/null 2>&1 || die "k3s not found"

status_json() { k3s secrets-encrypt status -o json || die "k3s secrets-encrypt status failed (is k3s running?)"; }
read_status() {   # -> ENABLE STAGE
  local json
  json=$(status_json)
  ENABLE=$(jq -r '.enable // false' <<<"$json")
  STAGE=$(jq -r '.stage // ""' <<<"$json")
}

ensure_config_flag() {
  if [ -f "$K3S_CONFIG" ] && grep -Eq '^secrets-encryption:[[:space:]]*true[[:space:]]*$' "$K3S_CONFIG"; then
    return 0
  fi
  install -d -m 755 "$(dirname "$K3S_CONFIG")"
  if [ -f "$K3S_CONFIG" ] && grep -Eq '^secrets-encryption:' "$K3S_CONFIG"; then
    sed -i -E 's/^secrets-encryption:.*/secrets-encryption: true/' "$K3S_CONFIG"
  else
    # keep the file's last line intact when it has no trailing newline
    if [ -s "$K3S_CONFIG" ] && [ -n "$(tail -c1 "$K3S_CONFIG")" ]; then echo >> "$K3S_CONFIG"; fi
    echo 'secrets-encryption: true' >> "$K3S_CONFIG"
  fi
  chmod 600 "$K3S_CONFIG"
  log "secrets-encryption: true in $K3S_CONFIG"
}

restart_k3s() {
  local i
  log "restarting k3s (API unavailable for about a minute; running pods keep running)"
  systemctl restart k3s
  for i in $(seq 90); do
    kubectl get --raw /readyz >/dev/null 2>&1 && break
    [ "$i" -lt 90 ] || die "k3s API not ready 3 minutes after the restart; see journalctl -u k3s"
    sleep "$POLL"
  done
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
}

datastore_check() {
  local counts total plain
  if [ ! -f "$K3S_DATASTORE" ] || ! command -v python3 >/dev/null 2>&1; then
    log "datastore check skipped (no SQLite datastore at $K3S_DATASTORE, or no python3)"
    return 0
  fi
  # read-only; prints two counts, never a value
  counts=$(python3 -I - "$K3S_DATASTORE" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
rows = db.execute("""SELECT k.value FROM kine k
  JOIN (SELECT name, MAX(id) AS id FROM kine WHERE name LIKE '/registry/secrets/%' GROUP BY name) m ON k.id = m.id
  WHERE k.deleted = 0""").fetchall()
raw = [v if isinstance(v, bytes) else str(v or "").encode() for (v,) in rows]
print(len(raw), sum(1 for v in raw if not v.startswith(b"k8s:enc:")))
PY
  ) || die "cannot read $K3S_DATASTORE"
  read -r total plain <<<"$counts"
  [ "$plain" -eq 0 ] || die "$plain of $total Secrets are still stored unencrypted in $K3S_DATASTORE"
  log "datastore: $total/$total Secrets stored encrypted (current revisions)"
}

read_status
log "current state: enabled=$ENABLE stage=${STAGE:-none}"
if [ "$ENABLE" = true ] && [ "$STAGE" = reencrypt_finished ]; then
  log "Secrets encryption already enabled and every Secret rewritten; only verifying"
else
  if [ "$ENABLE" != true ]; then
    ensure_config_flag
    if [ -n "$STAGE" ]; then
      log "encryption config present but disabled: k3s secrets-encrypt enable"
      k3s secrets-encrypt enable
    fi
    restart_k3s
    read_status
    [ "$ENABLE" = true ] || die "k3s restarted but Secrets encryption is still disabled; check $K3S_CONFIG and journalctl -u k3s"
  fi
  log "rewriting every Secret with the active key: k3s secrets-encrypt reencrypt --force --skip"
  k3s secrets-encrypt reencrypt --force --skip
  for i in $(seq 90); do
    read_status
    [ "$STAGE" = reencrypt_finished ] && break
    [ "$i" -lt 90 ] || die "re-encryption did not finish within 3 minutes (stage $STAGE); see journalctl -u k3s"
    sleep "$POLL"
  done
fi

json=$(status_json)
[ "$(jq -r '.enable // false' <<<"$json")" = true ] || die "verification failed: encryption is not enabled"
[ "$(jq -r '.stage // ""' <<<"$json")" = reencrypt_finished ] || die "verification failed: stage is not reencrypt_finished"
text=$(k3s secrets-encrypt status)
printf '%s\n' "$text"
[ "$(jq -r '.hashmatch // false' <<<"$json")" = true ] || grep -q 'All hashes match' <<<"$text" \
  || die "verification failed: server encryption hashes do not match: $(jq -r '.hasherror // ""' <<<"$json")"
datastore_check
log "Secrets encryption at rest: on"
