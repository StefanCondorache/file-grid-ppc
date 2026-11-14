#!/usr/bin/env bash
# scripts/obs-helm.sh: helm upgrade runs only when the chart version, the values file or the extra args changed
# (checksum recorded in ConfigMap monitoring/obs-helm-checksums), or when the release is not deployed.
. "$(dirname "$0")/lib.sh"

SCRIPT=$REPO/scripts/obs-helm.sh
CM=obs-helm-checksums

setup_env() {
  sandbox kubectl helm
  VALUES=$SANDBOX/values.yaml
  echo 'a: 1' > "$VALUES"
}
obs_helm() { "$SCRIPT" grafana monitoring grafana/grafana 10.5.15 "$VALUES" --set-string "x=${DOMAIN_ARG:-ppc}" 2>&1; }
upgrades() { count_calls '^upgrade --install grafana'; }
recorded() { jq -r '.data["monitoring.grafana"] // ""' "$FAKE_STATE/obj/configmap/monitoring/$CM.json" 2>/dev/null; }

test_first_run_upgrades_and_records_the_checksum() {
  setup_env
  out=$(obs_helm); assert_status $? 0
  assert_eq "$(upgrades)" 1 "helm upgrade calls"
  assert_contains "$(calls)" "upgrade --install grafana grafana/grafana --version 10.5.15 -n monitoring -f $VALUES --wait --timeout 4m --set-string x=ppc"
  [ -n "$(recorded)" ] || fail "no checksum recorded in ConfigMap $CM"
}

test_unchanged_second_run_skips_helm_upgrade() {
  setup_env
  obs_helm >/dev/null
  out=$(obs_helm); assert_status $? 0
  assert_eq "$(upgrades)" 1 "helm upgrade calls after two runs"
  assert_contains "$out" "skipping helm upgrade"
}

test_changed_values_file_upgrades_again() {
  setup_env
  obs_helm >/dev/null; first=$(recorded)
  echo 'a: 2' > "$VALUES"
  obs_helm >/dev/null
  assert_eq "$(upgrades)" 2 "helm upgrade calls"
  [ "$(recorded)" != "$first" ] || fail "checksum not updated"
}

test_changed_extra_args_upgrade_again() {
  setup_env
  obs_helm >/dev/null
  DOMAIN_ARG=other obs_helm >/dev/null
  assert_eq "$(upgrades)" 2 "helm upgrade calls"
}

test_changed_chart_version_upgrades_again() {
  setup_env
  obs_helm >/dev/null
  "$SCRIPT" grafana monitoring grafana/grafana 10.6.0 "$VALUES" --set-string x=ppc >/dev/null 2>&1
  assert_eq "$(upgrades)" 2 "helm upgrade calls"
}

test_release_not_deployed_is_upgraded_even_with_a_matching_checksum() {
  setup_env
  obs_helm >/dev/null
  rm "$FAKE_STATE/helm/grafana"   # e.g. the release failed or was uninstalled
  obs_helm >/dev/null
  assert_eq "$(upgrades)" 2 "helm upgrade calls"
}

test_failed_upgrade_records_nothing_and_fails() {
  setup_env
  touch "$FAKE_STATE/helm-fail"
  out=$(obs_helm); rc=$?
  [ "$rc" -ne 0 ] || fail "expected a non-zero exit status"
  assert_eq "$(recorded)" "" "recorded checksum"
}

test_force_upgrades_even_when_unchanged() {
  setup_env
  obs_helm >/dev/null
  OBS_HELM_FORCE=1 obs_helm >/dev/null
  assert_eq "$(upgrades)" 2 "helm upgrade calls"
}

run_tests
