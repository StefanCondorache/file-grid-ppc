#!/usr/bin/env bash
# Static checks of the rendered manifests (offline: kubectl kustomize + kubectl annotate --local for YAML -> JSON).
. "$(dirname "$0")/lib.sh"

MW=traefik.ingress.kubernetes.io/router.middlewares

# Every object `make up` applies that these tests look at, as one JSON array.
render() {
  {
    cat "$REPO/deploy/k8s/placeholder.yaml"; echo '---'
    KUBECONFIG=/dev/null kubectl kustomize "$REPO/deploy/k8s/app"; echo '---'
    cat "$REPO/deploy/k8s/observability/grafana-ingress.yaml"; echo '---'
    cat "$REPO/deploy/k8s/observability/networkpolicies.yaml"
  } | KUBECONFIG=/dev/null kubectl annotate --local -f - filegrid.io/rendered-by=test -o json | jq -s .
}
OBJS=$(render) || { echo "cannot render manifests"; exit 1; }
q() { jq -r "$@" <<<"$OBJS"; }

test_every_ingress_on_the_host_uses_the_security_headers_middleware_of_its_namespace() {
  local ingresses n
  ingresses=$(q '.[] | select(.kind == "Ingress") | "\(.metadata.namespace)/\(.metadata.name)"' | sort | tr '\n' ' ')
  assert_eq "$ingresses" "filegrid/filegrid-api filegrid/filegrid-frontend filegrid/placeholder monitoring/grafana " "ingresses"
  n=$(q --arg a "$MW" '[.[] | select(.kind == "Ingress")
        | select((.metadata.annotations[$a] // "") != "\(.metadata.namespace)-security-headers@kubernetescrd")
        | .metadata.name] | join(" ")')
  assert_eq "$n" "" "ingresses without <namespace>-security-headers@kubernetescrd"
}

test_security_headers_middleware_exists_in_filegrid_and_monitoring_with_the_required_headers() {
  local ns h
  for ns in filegrid monitoring; do
    h=$(q --arg ns "$ns" '[.[] | select(.kind == "Middleware" and .metadata.name == "security-headers"
          and .metadata.namespace == $ns)] | if length == 1 then .[0].spec.headers | tojson else "missing" end')
    assert_eq "$(jq -r '.stsSeconds' <<<"$h" 2>/dev/null)" 31536000 "$ns stsSeconds"
    assert_eq "$(jq -r '.stsIncludeSubdomains // false' <<<"$h" 2>/dev/null)" false "$ns stsIncludeSubdomains"
    assert_eq "$(jq -r '.stsPreload // false' <<<"$h" 2>/dev/null)" false "$ns stsPreload"
    assert_eq "$(jq -r '.contentTypeNosniff' <<<"$h" 2>/dev/null)" true "$ns contentTypeNosniff"
    assert_eq "$(jq -r '.referrerPolicy' <<<"$h" 2>/dev/null)" strict-origin-when-cross-origin "$ns referrerPolicy"
    assert_eq "$(jq -r '.frameDeny' <<<"$h" 2>/dev/null)" true "$ns frameDeny"
  done
}

# A YAML document (helm values) on stdin as JSON (wrapped in a dummy object for kubectl's offline YAML parser)
yaml_json() {
  { printf 'apiVersion: test.filegrid.io/v1\nkind: Values\nmetadata: {name: v}\nvalues:\n'; sed 's/^/  /'; } \
    | KUBECONFIG=/dev/null kubectl annotate --local -f - x=y -o json | jq -c .values
}
values() { yaml_json < "$REPO/deploy/k8s/observability/$1-values.yaml"; }
# valuesContent of the k3s HelmChartConfig for Traefik, as JSON
traefik_values() {
  KUBECONFIG=/dev/null kubectl annotate --local -f "$REPO/deploy/k8s/traefik-config.yaml" x=y -o json \
    | jq -r .spec.valuesContent | yaml_json
}

test_grafana_cookies_are_secure_and_strict_metrics_off_no_phone_home_version_hidden() {
  local v
  v=$(values grafana)
  assert_eq "$(jq -c '.["grafana.ini"].security' <<<"$v")" '{"cookie_samesite":"strict","cookie_secure":true}' "security"
  assert_eq "$(jq -r '.["grafana.ini"].metrics.enabled' <<<"$v")" false "metrics.enabled"
  assert_eq "$(jq -r '.["grafana.ini"]["auth.anonymous"].hide_version' <<<"$v")" true "auth.anonymous.hide_version"
  assert_eq "$(jq -r '.["grafana.ini"]["auth.anonymous"].enabled' <<<"$v")" false "auth.anonymous.enabled"
  assert_eq "$(jq -c '.["grafana.ini"].analytics | [.reporting_enabled, .check_for_updates, .check_for_plugin_updates,
    .feedback_links_enabled]' <<<"$v")" '[false,false,false,false]' "analytics"
}

test_grafana_sidecar_and_alloy_get_the_raised_memory_limits() {
  assert_eq "$(values grafana | jq -r '.resources.limits.memory')" 256Mi "grafana memory limit"
  assert_eq "$(values grafana | jq -r '.sidecar.resources.limits.memory')" 160Mi "grafana sidecar memory limit"
  assert_eq "$(values alloy | jq -r '.alloy.resources.limits.memory')" 192Mi "alloy memory limit"
}

test_traefik_keeps_the_client_ip_and_trusts_forwarded_headers_only_from_the_pod_cidr() {
  local v ep
  v=$(traefik_values)
  assert_eq "$(jq -r '.service.spec.externalTrafficPolicy' <<<"$v")" Local "service.spec.externalTrafficPolicy"
  for ep in web websecure; do
    assert_eq "$(jq -c --arg e "$ep" '.ports[$e].forwardedHeaders.trustedIPs' <<<"$v")" '["10.42.0.0/16"]' \
      "ports.$ep.forwardedHeaders.trustedIPs"
    assert_eq "$(jq -r --arg e "$ep" '.ports[$e].forwardedHeaders.insecure // false' <<<"$v")" false \
      "ports.$ep.forwardedHeaders.insecure"
  done
  # unchanged settings stay
  assert_eq "$(jq -r '.ports.websecure.transport.respondingTimeouts.readTimeout' <<<"$v")" 900s "readTimeout"
  assert_eq "$(jq -r '.ports.web.http.redirections.entryPoint.to' <<<"$v")" websecure "HTTP -> HTTPS redirect"
}

test_backend_trusts_x_forwarded_for_only_from_the_cluster_cidrs() {
  assert_eq "$(q '.[] | select(.kind == "Deployment" and .metadata.name == "filegrid-backend")
      | .spec.template.spec.containers[0].env[] | select(.name == "TRUSTED_PROXY_CIDRS") | .value')" \
    "10.42.0.0/16,10.43.0.0/16" "backend TRUSTED_PROXY_CIDRS"
}

run_tests
