#!/usr/bin/env bash
# `make up` idempotency at the make-target level: k8s-tls-up leaves the placeholder to the app-up swap logic,
# docker builds are reproducible (no provenance attestation), `make status` prints each host once.
. "$(dirname "$0")/lib.sh"

test_k8s_tls_up_never_touches_the_placeholder() {
  local out
  out=$(make -n -C "$REPO" --no-print-directory k8s-tls-up DOMAIN=ppc.filegrid.cc.cd 2>&1)
  assert_contains "$out" "k8s-traefik-config.sh" "make -n k8s-tls-up"
  assert_not_contains "$out" "placeholder" "make -n k8s-tls-up"
}

test_app_images_are_built_without_provenance_attestations() {
  sandbox docker k3s
  APP_TAG=t "$REPO/scripts/k8s-app-images.sh" >/dev/null 2>&1; assert_status $? 0
  local builds
  builds=$(grep '^docker build' "$FAKE_STATE/calls")
  assert_eq "$(grep -c . <<<"$builds")" 3 "docker build calls (backend, frontend, simulator)"
  assert_eq "$(grep -c -- '--provenance=false' <<<"$builds")" 3 "docker build calls with --provenance=false"
}

test_status_prints_each_host_once() {
  sandbox kubectl
  printf 'ppc.example.test\nppc.example.test\nppc.example.test\n' > "$FAKE_STATE/hosts"
  printf 'True' > "$FAKE_STATE/ready"
  printf '%s\t%s\t0\n' 'get ingress -A -o jsonpath=' "$FAKE_STATE/hosts" \
    'get certificate -o jsonpath=' "$FAKE_STATE/ready" > "$FAKE_STATE/canned.tsv"
  local out
  out=$(make -s -C "$REPO" --no-print-directory status 2>&1)
  assert_eq "$(grep -c 'https://ppc.example.test' <<<"$out")" 1 "lines with https://ppc.example.test"
}

run_tests
