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

run_tests
