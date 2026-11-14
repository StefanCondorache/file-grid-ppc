#!/usr/bin/env bash
# scripts/k8s-app-secrets.sh: Secret filegrid-app-secrets is created once; DEMO_USERS_PASSWORD (separate from
# ADMIN_PASSWORD) is added to an existing Secret without touching the other keys; values are never printed or
# put on a command line.
. "$(dirname "$0")/lib.sh"

SCRIPT=$REPO/scripts/k8s-app-secrets.sh
SECRET=obj/secret/filegrid/filegrid-app-secrets.json
ALL_KEYS='ADMIN_PASSWORD ADMIN_USERNAME DEMO_USERS_PASSWORD FILEGRID_KEK FILEGRID_KEK_ID JWT_SECRET METER_API_KEY'

key() { jq -r --arg k "$1" '.data[$k] // "" | @base64d' "$FAKE_STATE/$SECRET"; }
keys() { jq -r '.data | keys | join(" ")' "$FAKE_STATE/$SECRET"; }

# A Secret as created before DEMO_USERS_PASSWORD existed (fixed fake values).
seed_old_secret() {
  mkdir -p "$FAKE_STATE/obj/namespace/_" "$(dirname "$FAKE_STATE/$SECRET")"
  echo '{}' > "$FAKE_STATE/obj/namespace/_/filegrid.json"
  jq -n '{apiVersion:"v1",kind:"Secret",metadata:{name:"filegrid-app-secrets",namespace:"filegrid"},
          data:({FILEGRID_KEK:"kek-old",FILEGRID_KEK_ID:"k1",JWT_SECRET:"jwt-old",METER_API_KEY:"meter-old",
                 ADMIN_USERNAME:"admin",ADMIN_PASSWORD:"admin-old-pw"} | map_values(@base64))}' > "$FAKE_STATE/$SECRET"
}

test_fresh_cluster_gets_every_key_including_a_24_char_demo_password() {
  sandbox kubectl
  out=$("$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(keys)" "$ALL_KEYS" "keys"
  demo=$(key DEMO_USERS_PASSWORD)
  assert_eq "${#demo}" 24 "DEMO_USERS_PASSWORD length"
  [[ $demo =~ ^[A-Za-z0-9]+$ ]] || fail "DEMO_USERS_PASSWORD is not alphanumeric"
  [ "$demo" != "$(key ADMIN_PASSWORD)" ] || fail "demo password equals the admin password"
  assert_not_contains "$out" "$demo" "script output"
  assert_not_contains "$(calls)" "$demo" "kubectl command lines"
}

test_existing_secret_gets_demo_password_added_without_rotating_other_keys() {
  sandbox kubectl
  seed_old_secret
  before=$(jq -c '.data' "$FAKE_STATE/$SECRET")
  out=$("$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(keys)" "$ALL_KEYS" "keys"
  assert_eq "$(jq -c --argjson b "$before" '.data | with_entries(select(.key != "DEMO_USERS_PASSWORD")) == $b' \
    "$FAKE_STATE/$SECRET")" true "existing keys unchanged"
  demo=$(key DEMO_USERS_PASSWORD)
  assert_eq "${#demo}" 24 "DEMO_USERS_PASSWORD length"
  assert_contains "$out" "DEMO_USERS_PASSWORD"
  assert_not_contains "$out" "$demo" "script output"
  assert_not_contains "$(calls)" "$demo" "kubectl command lines"
}

test_second_run_changes_nothing() {
  sandbox kubectl
  "$SCRIPT" >/dev/null 2>&1
  first=$(cat "$FAKE_STATE/$SECRET")
  : > "$FAKE_STATE/calls"
  out=$("$SCRIPT" 2>&1); assert_status $? 0
  assert_eq "$(cat "$FAKE_STATE/$SECRET")" "$first" "secret after second run"
  assert_eq "$(count_calls 'patch')$(count_calls 'create')" 00 "patch/create calls on the second run"
  assert_contains "$out" "keeping it"
}

run_tests
