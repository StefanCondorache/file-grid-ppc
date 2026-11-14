#!/usr/bin/env bash
# scripts/k8s-app-up.sh owns "/" alone (placeholder or frontend). Since k8s-tls-up no longer applies the
# placeholder, the first `make up` reaches app-up with no Certificate at all: a first Let's Encrypt issuance must
# not block (no DNS / closed ports on a test machine), while re-adopting an already issued certificate still waits.
. "$(dirname "$0")/lib.sh"

SCRIPT=$REPO/scripts/k8s-app-up.sh

setup_env() {   # <components with an image...>
  sandbox kubectl k3s
  local c
  : > "$FAKE_STATE/k3s-images"
  for c in "$@"; do echo "docker.io/library/filegrid-$c:t" >> "$FAKE_STATE/k3s-images"; done
  # The Certificate appears (created by cert-manager's ingress-shim) but has no owner yet.
  printf '%s\t%s\t0\n' 'get certificate ppc-filegrid-tls -o jsonpath=' /dev/null \
    'get certificate ppc-filegrid-tls$' /dev/null > "$FAKE_STATE/canned.tsv"
}
issued_secret() {
  mkdir -p "$FAKE_STATE/obj/secret/filegrid"
  echo '{"data":{}}' > "$FAKE_STATE/obj/secret/filegrid/ppc-filegrid-tls.json"
}
app_up() { APP_TAG=t "$SCRIPT" 2>&1; }
ready_waits() { count_calls 'wait --for=condition=Ready certificate/ppc-filegrid-tls'; }

test_first_issuance_with_frontend_does_not_block_and_never_applies_the_placeholder() {
  setup_env backend frontend simulator
  out=$(app_up); assert_status $? 0
  assert_eq "$(ready_waits)" 0 "waits for the certificate to become Ready"
  assert_contains "$out" "requested for the first time"
  assert_eq "$(count_calls 'rollout status deploy/placeholder')" 0 "placeholder rollouts"
  assert_contains "$(calls)" "delete ingress/placeholder deploy/placeholder svc/placeholder configmap/placeholder-site"
}

test_first_issuance_without_frontend_does_not_block() {
  setup_env backend simulator
  out=$(app_up); assert_status $? 0
  assert_eq "$(count_calls 'rollout status deploy/placeholder')" 1 "placeholder rollouts"
  assert_eq "$(ready_waits)" 0 "waits for the certificate to become Ready"
}

test_already_issued_certificate_is_waited_for_after_the_swap() {
  setup_env backend frontend simulator
  issued_secret
  out=$(app_up); assert_status $? 0
  assert_eq "$(ready_waits)" 1 "waits for the certificate to become Ready"
}

run_tests
