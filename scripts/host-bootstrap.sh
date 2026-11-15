#!/usr/bin/env bash
# First step of `make up`: prepares the host for the k8s targets. Idempotent; every step runs only when needed:
#   1. curl, ca-certificates, openssl, jq: installed with apt only if missing
#   2. k3s K3S_VERSION (default: the version tested on the VPS), only if k3s is absent.
#      K3S_CHANNEL=stable|latest opts in to the newest k3s of that channel instead (untested combination).
#      An existing k3s is never reinstalled or restarted, so flags of a new install (host-gw, Secrets encryption)
#      do not reach it: the current VPS runs k3s installed without them.
#   3. ~/.kube/config: a copy of the k3s kubeconfig for manual helm/kubectl use, only if it does not exist
#      (make itself exports KUBECONFIG=/etc/rancher/k3s/k3s.yaml, so helm and kubectl read the same cluster)
#   4. Helm HELM_VERSION (get-helm-3 from the same Helm tag), only if helm is absent
#   5. waits until the node, CoreDNS, local-path storage and Traefik are ready
#   6. reports whether Secrets are encrypted at rest. It never turns that on for an existing k3s (that needs a k3s
#      restart): on such a k3s, like the current VPS, encryption stays OFF until `sudo make k3s-secrets-encrypt`.
# Must run as root: apt, the k3s installer and the mode-600 k3s kubeconfig all need it (sudo make up).
set -euo pipefail

K3S_VERSION=${K3S_VERSION:-v1.37.2+k3s1}   # tested; it fixes the bundled Traefik chart (deploy/k8s/traefik-config.yaml)
K3S_CHANNEL=${K3S_CHANNEL:-}               # opt-in, overrides K3S_VERSION
HELM_VERSION=${HELM_VERSION:-v3.22.1}
K3S_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
USER_KUBECONFIG=$HOME/.kube/config
export KUBECONFIG=${KUBECONFIG:-$K3S_KUBECONFIG}

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
retry() {   # <what> <command...>: up to 5 minutes, every 5s; on timeout shows the command's last output
  local what=$1 i out=""
  shift
  for i in $(seq 60); do
    out=$("$@" 2>&1) && return 0
    [ "$i" = 1 ] && log "waiting for $what"
    sleep 5
  done
  die "timed out waiting for $what; last output: ${out:-<none>}"
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
# Docker builds the app images (scripts/k8s-app-images.sh, which uses buildx flags): Ubuntu's docker.io + docker-buildx
command -v docker >/dev/null 2>&1 || missing+=(docker.io docker-buildx)
if [ "${#missing[@]}" -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || die "missing: ${missing[*]} (no apt-get here; install them first)"
  log "installing ${missing[*]} (apt)"
  export DEBIAN_FRONTEND=noninteractive
  # A freshly booted Ubuntu often runs unattended-upgrades: wait for the dpkg lock instead of failing
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  apt-get -o DPkg::Lock::Timeout=600 install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi

# 2. k3s (it brings kubectl, Traefik, CoreDNS, local-path storage and the NetworkPolicy controller)
if command -v k3s >/dev/null 2>&1; then
  log "k3s present ($(k3s --version | head -n1)); not reinstalling"
  if command -v systemctl >/dev/null 2>&1 && systemctl cat k3s.service >/dev/null 2>&1; then
    systemctl is-active --quiet k3s || die "k3s is installed but not running; start it with: systemctl start k3s"
  fi
else
  if [ -n "$K3S_CHANNEL" ]; then version=""; what="latest in channel $K3S_CHANNEL"
  else version=$K3S_VERSION; what=$K3S_VERSION; fi
  log "installing k3s ($what)"
  curl -sSfL https://get.k3s.io -o "$tmp/k3s-install.sh"
  # host-gw: single node, so no VXLAN socket (UDP 8472) on the public interface; multi-node on separate
  # networks would need vxlan or wireguard-native. --secrets-encryption: Secrets encrypted at rest in the datastore
  # from the first start (a new install only; an existing k3s: make k3s-secrets-encrypt).
  INSTALL_K3S_CHANNEL=${K3S_CHANNEL:-stable} INSTALL_K3S_VERSION=$version \
    sh "$tmp/k3s-install.sh" server --write-kubeconfig-mode 600 --flannel-backend=host-gw --secrets-encryption
fi

# 3. kubectl and helm read $KUBECONFIG; the ~/.kube/config copy is only a convenience for manual commands
retry "$K3S_KUBECONFIG" test -s "$K3S_KUBECONFIG"
if [ ! -e "$USER_KUBECONFIG" ]; then
  log "copying $K3S_KUBECONFIG to $USER_KUBECONFIG"
  install -D -m 600 "$K3S_KUBECONFIG" "$USER_KUBECONFIG"
fi

# 4. Helm
if command -v helm >/dev/null 2>&1; then
  log "helm present ($(helm version --short)); not reinstalling"
else
  log "installing helm $HELM_VERSION (get-helm-3)"
  curl -sSfL "https://raw.githubusercontent.com/helm/helm/$HELM_VERSION/scripts/get-helm-3" -o "$tmp/get-helm-3"
  DESIRED_VERSION=$HELM_VERSION bash "$tmp/get-helm-3"
fi

# 5. The next steps need the API, DNS, PVCs and Traefik (k3s installs Traefik through a Helm job, so its
#    Deployment appears a while after the node; the HelmChartConfig CRD used by k8s-tls-up exists by then).
retry "the k3s API and node" sh -c '[ -n "$(kubectl get nodes -o name)" ]'
kubectl wait --for=condition=Ready node --all --timeout=300s >/dev/null
retry "CoreDNS, local-path-provisioner and Traefik" \
  kubectl -n kube-system get deploy coredns local-path-provisioner traefik
kubectl -n kube-system rollout status deploy/coredns deploy/local-path-provisioner deploy/traefik --timeout=300s

# 6. Secrets encryption at rest: reported, never changed here
encryption=$(k3s secrets-encrypt status 2>/dev/null || true)
if grep -q '^Encryption Status: Enabled' <<<"$encryption"; then
  log "Secrets encryption at rest: on"
else
  log "Secrets encryption at rest: OFF on this k3s (${encryption%%$'\n'*});" \
    "turn it on with: sudo make k3s-secrets-encrypt (restarts k3s once)"
fi
