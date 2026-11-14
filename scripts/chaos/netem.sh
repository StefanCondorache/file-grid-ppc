#!/usr/bin/env bash
# Demo chaos: degrade the network of ONE pod with tc netem (latency, jitter, packet loss).
#   scripts/chaos/netem.sh on     <namespace> <pod> [delay=300ms] [jitter=50ms] [loss=5%]
#   scripts/chaos/netem.sh off    <namespace> <pod>
#   scripts/chaos/netem.sh status <namespace> <pod>
# Example: scripts/chaos/netem.sh on filegrid-storage s3-0 400ms 100ms 10%
#
# SSH safety: tc runs ONLY inside the pod's own network namespace (nsenter -t <container PID> -n), on that
# namespace's eth0. The host's interfaces (eth0, wg0, cni0, the veth pairs) are never touched. The script refuses
# to run when the target namespace is the host's (hostNetwork pods) or when the PID cannot be resolved.
# Egress of the pod is shaped, so every connection of the pod (both directions of a request/response) gets the
# added delay once per round trip. The qdisc vanishes with the pod (a restarted pod starts clean).
# Needs root on the k3s node, tc (iproute2), nsenter and crictl (k3s ships it: k3s crictl).
set -euo pipefail

usage() { echo "usage: $0 on|off|status <namespace> <pod> [delay=300ms] [jitter=50ms] [loss=5%]" >&2; exit 2; }

cmd=${1:-}; ns=${2:-}; pod=${3:-}
delay=${4:-${DELAY:-300ms}}; jitter=${5:-${JITTER:-50ms}}; loss=${6:-${LOSS:-5%}}
case "$cmd" in on|off|status) ;; *) usage ;; esac
[ -n "$ns" ] && [ -n "$pod" ] || usage

# Strict validation: these strings end up on a root command line.
k8s_name='^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'
[[ $ns =~ $k8s_name && $pod =~ $k8s_name ]] || { echo "invalid namespace/pod name" >&2; exit 2; }
[[ $delay =~ ^[0-9]+(us|ms|s)$ ]]  || { echo "invalid delay '$delay' (e.g. 300ms)" >&2; exit 2; }
[[ $jitter =~ ^[0-9]+(us|ms|s)$ ]] || { echo "invalid jitter '$jitter' (e.g. 50ms)" >&2; exit 2; }
[[ $loss =~ ^[0-9]+(\.[0-9]+)?%$ ]] || { echo "invalid loss '$loss' (e.g. 5%)" >&2; exit 2; }

[ "$(id -u)" = 0 ] || { echo "must run as root (nsenter into the pod network namespace)" >&2; exit 1; }
command -v tc >/dev/null || { echo "tc not found: apt-get install -y iproute2" >&2; exit 1; }
command -v nsenter >/dev/null || { echo "nsenter not found: apt-get install -y util-linux" >&2; exit 1; }
if command -v crictl >/dev/null; then CRICTL=(crictl)
elif command -v k3s >/dev/null; then CRICTL=(k3s crictl)
else echo "crictl not found (k3s crictl)" >&2; exit 1; fi

hostnet=$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.spec.hostNetwork}') || exit 1
if [ "$hostnet" = true ]; then
  echo "refusing: $ns/$pod uses hostNetwork, its eth0 IS the host's eth0" >&2; exit 1
fi
cid=$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].containerID}')
cid=${cid#*://}
[ -n "$cid" ] || { echo "pod $ns/$pod has no running container" >&2; exit 1; }
pid=$("${CRICTL[@]}" inspect --output go-template --template '{{.info.pid}}' "$cid" 2>/dev/null) \
  || { echo "container of $ns/$pod not found on this node (run on the node that hosts it)" >&2; exit 1; }
[[ $pid =~ ^[1-9][0-9]*$ ]] || { echo "could not resolve the container PID" >&2; exit 1; }

# Second guard: the pod's network namespace must differ from the host's (PID 1).
if [ "$(readlink "/proc/$pid/ns/net")" = "$(readlink /proc/1/ns/net)" ]; then
  echo "refusing: $ns/$pod shares the host network namespace" >&2; exit 1
fi

podtc() { nsenter -t "$pid" -n tc "$@"; }

case "$cmd" in
  on)
    podtc qdisc replace dev eth0 root netem delay "$delay" "$jitter" loss "$loss"
    echo "netem ON for $ns/$pod: delay $delay +/- $jitter, loss $loss (pod netns only)"
    echo "Jury: uploads/downloads touching $pod get slower (Grafana p95/p99 rise), retries absorb the loss,"
    echo "      nothing is lost or duplicated; other storages/categories keep their normal latency."
    ;;
  off)
    # Deleting the root qdisc restores the kernel default; "no such qdisc" just means it was already off.
    if podtc qdisc show dev eth0 | grep -q netem; then podtc qdisc del dev eth0 root; fi
    echo "netem OFF for $ns/$pod"
    ;;
esac
echo "$ns/$pod eth0 qdisc: $(podtc qdisc show dev eth0)"
