#!/usr/bin/env bash
# First step of `make up`: prepares the host for the k8s targets. Idempotent; every step runs only when needed:
#   1. curl, ca-certificates, openssl, jq: installed with apt only if missing
#   2. k3s (channel K3S_CHANNEL, default stable; or exactly K3S_VERSION), only if k3s is absent.
#      An existing k3s is never reinstalled or restarted.
#   3. ~/.kube/config for helm: a copy of the k3s kubeconfig, only if it does not exist
#   4. Helm 3 (official get-helm-3 script, version HELM_VERSION), only if helm is absent
#   5. waits until the node, CoreDNS, local-path storage and Traefik are ready
# Must run as root: apt, the k3s installer and the mode-600 k3s kubeconfig all need it (sudo make up).
set -euo pipefail

K3S_CHANNEL=${K3S_CHANNEL:-stable}
K3S_VERSION=${K3S_VERSION:-}            # e.g. v1.37.2+k3s1 (the version on the VPS); empty = latest in channel
HELM_VERSION=${HELM_VERSION:-v3.22.1}
K3S_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
USER_KUBECONFIG=$HOME/.kube/config

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
retry() {   # <what> <command...>: up to 5 minutes, every 5s
  local what=$1 i
  shift
  for i in $(seq 60); do
    "$@" >/dev/null 2>&1 && return 0
    [ "$i" = 1 ] && log "waiting for $what"
    sleep 5
  done
  die "timed out waiting for $what"
}

[ "$(id -u)" -eq 0 ] || die "make up must run as root (apt, k3s, root-only kubeconfig): sudo make up"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. Tools used by the installers and by scripts/*.sh
missing=()
for tool in curl openssl jq; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[ -s /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
if [ "${#missing[@]}" -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || die "missing: ${missing[*]} (no apt-get here; install them first)"
  log "installing ${missing[*]} (apt)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi

# 2. k3s (it brings kubectl, Traefik, CoreDNS, local-path storage and the NetworkPolicy controller)
if command -v k3s >/dev/null 2>&1; then
  log "k3s present ($(k3s --version | head -n1)); not reinstalling"
else
  log "installing k3s (${K3S_VERSION:-latest $K3S_CHANNEL})"
  curl -sfL https://get.k3s.io -o "$tmp/k3s-install.sh"
  INSTALL_K3S_CHANNEL=$K3S_CHANNEL INSTALL_K3S_VERSION=$K3S_VERSION \
    sh "$tmp/k3s-install.sh" server --write-kubeconfig-mode 600
fi

# 3. kubectl (as root) reads the k3s kubeconfig itself; helm reads ~/.kube/config
retry "$K3S_KUBECONFIG" test -s "$K3S_KUBECONFIG"
if [ ! -e "$USER_KUBECONFIG" ]; then
  log "copying $K3S_KUBECONFIG to $USER_KUBECONFIG"
  install -D -m 600 "$K3S_KUBECONFIG" "$USER_KUBECONFIG"
elif ! cmp -s "$K3S_KUBECONFIG" "$USER_KUBECONFIG"; then
  log "warning: $USER_KUBECONFIG differs from $K3S_KUBECONFIG and is left as is; helm uses it." \
    "If it is not meant for this k3s: install -m 600 $K3S_KUBECONFIG $USER_KUBECONFIG"
fi

# 4. Helm
if command -v helm >/dev/null 2>&1; then
  log "helm present ($(helm version --short)); not reinstalling"
else
  log "installing helm $HELM_VERSION (get-helm-3)"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o "$tmp/get-helm-3"
  DESIRED_VERSION=$HELM_VERSION bash "$tmp/get-helm-3"
fi

# 5. The next steps need the API, DNS, PVCs and Traefik (k3s installs Traefik through a Helm job, so its
#    Deployment appears a while after the node; the HelmChartConfig CRD used by k8s-tls-up exists by then).
retry "the k3s API and node" sh -c '[ -n "$(kubectl get nodes -o name)" ]'
kubectl wait --for=condition=Ready node --all --timeout=300s >/dev/null
retry "CoreDNS, local-path-provisioner and Traefik" \
  kubectl -n kube-system get deploy coredns local-path-provisioner traefik
kubectl -n kube-system rollout status deploy/coredns deploy/local-path-provisioner deploy/traefik --timeout=300s
