#!/usr/bin/env bash
# scripts/k3s-secrets-encrypt.sh (make k3s-secrets-encrypt): enables Secrets encryption at rest on an existing k3s,
# restarts k3s only when needed, rewrites every Secret, verifies the status and the datastore; idempotent.
# FAKE_REENCRYPT_DB makes the fake `k3s secrets-encrypt reencrypt` rewrite the Secret rows of that SQLite file.
. "$(dirname "$0")/lib.sh"

SCRIPT=$REPO/scripts/k3s-secrets-encrypt.sh

setup_env() {
  sandbox kubectl k3s systemctl id
  export K3S_CONFIG=$SANDBOX/etc/config.yaml K3S_DATASTORE=$SANDBOX/state.db K3S_ENCRYPT_POLL=0
  # a kine datastore with two Secrets (one with an older revision) and a ConfigMap, all in plaintext
  python3 -I - "$K3S_DATASTORE" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE kine (id INTEGER PRIMARY KEY, name TEXT, created INT, deleted INT, create_revision INT,"
           " prev_revision INT, lease INT, value BLOB, old_value BLOB)")
for i, (name, value) in enumerate([("/registry/secrets/filegrid/a", b"k8s\x00old"), ("/registry/secrets/filegrid/a", b"k8s\x00a"),
                                   ("/registry/secrets/monitoring/b", b"k8s\x00b"), ("/registry/configmaps/filegrid/c", b"k8s\x00c")], 1):
    db.execute("INSERT INTO kine VALUES (?, ?, 0, 0, ?, 0, 0, ?, NULL)", (i, name, i, value))
db.commit()
PY
}

test_k3s_without_encryption_is_enabled_restarted_reencrypted_and_verified() {
  setup_env
  mkdir -p "$(dirname "$K3S_CONFIG")"; printf 'write-kubeconfig-mode: "0600"' > "$K3S_CONFIG"   # no trailing newline
  out=$(FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(cat "$K3S_CONFIG")" $'write-kubeconfig-mode: "0600"\nsecrets-encryption: true' "config.yaml"
  assert_eq "$(count_calls '^systemctl restart k3s')" 1 "k3s restarts"
  assert_eq "$(count_calls 'secrets-encrypt reencrypt --force --skip')" 1 "reencrypt calls"
  assert_eq "$(count_calls 'secrets-encrypt enable')" 0 "enable calls (no config yet: the flag does it)"
  assert_contains "$out" "Encryption Status: Enabled"
  assert_contains "$out" "2/2 Secrets"
}

test_second_run_only_verifies() {
  setup_env
  FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" >/dev/null 2>&1
  : > "$FAKE_STATE/calls"
  out=$(FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(count_calls '^systemctl restart')$(count_calls 'reencrypt')$(count_calls 'secrets-encrypt enable')" 000 \
    "restarts, reencrypts, enables on the second run"
  assert_contains "$out" "already"
}

test_k3s_installed_with_the_flag_is_reencrypted_without_a_restart() {
  setup_env
  echo "true start" > "$FAKE_STATE/k3s-enc"
  out=$(FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(count_calls '^systemctl restart')" 0 "k3s restarts"
  assert_eq "$(count_calls 'secrets-encrypt reencrypt --force --skip')" 1 "reencrypt calls"
  [ ! -f "$K3S_CONFIG" ] || assert_contains "$(cat "$K3S_CONFIG")" "secrets-encryption: true"
}

test_disabled_encryption_config_is_enabled_then_restarted() {
  setup_env
  echo "false reencrypt_finished" > "$FAKE_STATE/k3s-enc"
  out=$(FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(count_calls 'secrets-encrypt enable')" 1 "enable calls"
  assert_eq "$(count_calls '^systemctl restart k3s')" 1 "k3s restarts"
  assert_eq "$(count_calls 'secrets-encrypt reencrypt --force --skip')" 1 "reencrypt calls"
}

test_fails_when_k3s_comes_back_without_encryption() {
  setup_env
  touch "$FAKE_STATE/k3s-ignores-config"
  out=$(FAKE_REENCRYPT_DB=$K3S_DATASTORE "$SCRIPT" 2>&1); rc=$?
  [ "$rc" -ne 0 ] || fail "expected a non-zero exit status"
  assert_eq "$(count_calls 'reencrypt')" 0 "reencrypt calls"
  assert_contains "$out" "error:"
}

test_fails_when_the_datastore_still_holds_plaintext_secrets() {
  setup_env
  out=$("$SCRIPT" 2>&1); rc=$?   # no FAKE_REENCRYPT_DB: status says done, the rows stay plaintext
  [ "$rc" -ne 0 ] || fail "expected a non-zero exit status"
  assert_contains "$out" "2 of 2 Secrets are still stored unencrypted"
}

run_tests
