#!/usr/bin/env bash
# Live proof that the storages in filegrid-storage are reachable only by FileGrid app pods
# (namespace filegrid + label filegrid.io/storage-client=true). Three short-lived pinned client pods:
#   filegrid, labelled     the allowed client, and the POSITIVE CONTROL for every target
#   filegrid, unlabelled   must be blocked (it even holds the real credentials)
#   default ns, labelled   must be blocked (the label alone, outside namespace filegrid, is not enough)
#
# How a row is decided:
# - Every probe runs INSIDE a client pod and prints exactly one line "ISOCHECK <TOKEN> <detail>":
#     OK       the real protocol operation worked (psql SELECT 1, signed S3 HEAD bucket, FTP LIST over PASV)
#     OPEN     TCP handshake completed
#     REACHED  the server answered, but the operation failed (auth, HTTP status, ...)
#     REFUSED  connect() failed with "connection refused"
#     TIMEOUT  no answer to the SYN within the 3s connect timeout (DNS had resolved)
#     ERROR    anything else (DNS failure, missing tool, unexpected output)
#   Tokens come from curl exit codes / timing fields and psql error text, never from elapsed time.
#   A failed kubectl exec, a missing or repeated result line, or an unknown token makes the row FAIL
#   ("INVALID"); nothing ever defaults to "blocked".
# - k3s's kube-router REJECTs denied packets with ICMP port-unreachable, which the client reports as
#   "connection refused" (at once, or after a ~1s SYN retry while the kernel rate-limits ICMP). A port
#   with no listener looks the same. So "blocked" (REFUSED; or TIMEOUT, under a CNI that DROPs or if every
#   ICMP reply is rate-limited away) is accepted only on a port the labelled pod proved LIVE in this same
#   run, before and after the blocked probes:
#     postgres / s3 / ftp:21  the labelled pod's real operation, run first and re-checked at the end;
#     ftp passive ports       the labelled pod logs in and repeats PASV until pure-ftpd listens on the
#                             wanted port (21000, then 21009); the blocked pods probe that live listener;
#                             then the labelled pod connects to it (OPEN).
#   A listening socket answers a SYN with SYN-ACK, never with a refusal, so REFUSED there can only be
#   the policy. If a control fails (target down), the blocked rows for that target FAIL as well.
# - Exit 0 only if every row passes. Client pods are deleted on exit, error and Ctrl-C (trap); only after a
#   SIGKILL they linger, and then stop by themselves after activeDeadlineSeconds (600s).
#
# Test hook, to show the check fails loudly: ISOCHECK_FAULT=leak|nopod|notool|badtoken|s3down
#   leak      the "unlabelled" pod gets the storage-client label = a real isolation break
#   nopod     default-ns rows exec into a pod that does not exist
#   notool    default-ns rows run a command that does not exist in the image
#   badtoken  default-ns rows print an unknown token ("BLOCKED")
#   s3down    every client probes S3 at 192.0.2.1 (TEST-NET-1, nothing answers) = target down
set -uo pipefail

STORE=filegrid-storage
SECRET=filegrid-storage-credentials
PG_IMAGE=postgres:17.12-alpine     # psql
CURL_IMAGE=curlimages/curl:8.11.1  # curl (S3 sigv4, FTP, raw TCP) + busybox nc
PG_HOST=postgres.$STORE.svc.cluster.local
S3_HOST=s3.$STORE.svc.cluster.local
FTP_HOST=ftp.$STORE.svc.cluster.local
PASV_PORTS=(21000 21009)           # first and last port of the passive range
RUN=$(date +%H%M%S)-$$
declare -A NS=([lab]=filegrid [unl]=filegrid [def]=default)
declare -A STORAGE_LABEL=([lab]=yes [unl]=no [def]=yes)
declare -A DESC=([lab]="filegrid, labelled" [unl]="filegrid, unlabelled" [def]="default ns, labelled")
FAULT=${ISOCHECK_FAULT:-}
case $FAULT in
  ''|nopod|notool|badtoken) ;;
  leak) STORAGE_LABEL[unl]=yes; DESC[unl]="filegrid, LABELLED (fault)" ;;
  s3down) S3_HOST=192.0.2.1 ;;
  *) echo "unknown ISOCHECK_FAULT='$FAULT' (use leak|nopod|notool|badtoken|s3down)" >&2; exit 2 ;;
esac
declare -A POD HELD BEFORE AFTER
TMP=$(mktemp -d)
SEP=$'\x1f'
ROWS=()

cleanup() {
  local j
  for j in $(jobs -p); do kill "$j" 2>/dev/null; done
  for ns in filegrid default; do
    kubectl -n "$ns" delete pod -l "filegrid.io/isocheck-run=$RUN" \
      --force --grace-period=0 --ignore-not-found --wait=false >/dev/null 2>&1
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- in-pod probe (busybox sh). Always ends with exactly one "ISOCHECK <TOKEN> <detail>" line. ------------
# Credentials come from the pod's env (Secret via envFrom) and reach curl through -K - (stdin), never argv;
# raw tool output is never printed, only the token and a short detail built here.
read -r -d '' PROBE <<'EOF'
mode=$1 host=$2 port=$3 podip=${4:-} T=3
say() { echo "ISOCHECK $1 $2"; exit 0; }
num() { case $1 in ''|*[!0-9.]*) return 1;; esac; }
zero() { [ -z "$(printf %s "$1" | tr -d 0.)" ]; }
errline() { printf '%s\n' "$out" | grep '^curl: (' | tail -n1 | cut -c1-80; }
run_curl() {   # <curl config or ''> <curl args...>  -> out rc code dns conn
  cfg=$1; shift
  if [ -n "$cfg" ]; then
    out=$(printf '%s\n' "$cfg" | curl -sS -v --connect-timeout $T -K - \
      -w '\nISOW %{response_code} %{time_namelookup} %{time_connect}\n' "$@" 2>&1); rc=$?
  else
    out=$(curl -sS -v --connect-timeout $T \
      -w '\nISOW %{response_code} %{time_namelookup} %{time_connect}\n' "$@" </dev/null 2>&1); rc=$?
  fi
  set -- $(printf '%s\n' "$out" | grep '^ISOW ' | tail -n1)
  code=${2:-} dns=${3:-} conn=${4:-}
  num "$dns" && num "$conn" || say ERROR "curl rc=$rc, no timing output"
}
net_fail() {   # classify a curl failure where TCP never connected; returns if it did connect
  zero "$conn" || return 0
  case $rc in
    6) say ERROR "DNS lookup failed" ;;
    7) case $out in *"Connection refused"*) say REFUSED "connection refused" ;; esac
       say ERROR "connect failed: $(errline)" ;;
    28) zero "$dns" && say ERROR "DNS lookup timed out"
        say TIMEOUT "no reply to SYN within ${T}s" ;;
  esac
  say ERROR "curl rc=$rc: $(errline)"
}
case $mode in
pg)
  out=$(PGPASSWORD=${POSTGRES_PASSWORD:-isocheck} PGCONNECT_TIMEOUT=$T psql -X -w -h "$host" -p "$port" \
        -U "${POSTGRES_USER:-isocheck}" -d "${POSTGRES_DB:-isocheck}" -tAc 'SELECT 1' 2>&1); rc=$?
  [ "$rc" = 0 ] && [ "$out" = 1 ] && say OK "SELECT 1 returned 1"
  case $out in
    *"timeout expired"*) say TIMEOUT "no reply within ${T}s" ;;
    *"Connection refused"*) say REFUSED "connection refused" ;;
    *"could not translate host name"*) say ERROR "DNS lookup failed" ;;
    *FATAL*|*authentication*|*password*)
      say REACHED "server answered: $(printf '%s\n' "$out" | grep -o 'FATAL.*' | head -n1 | cut -c1-60)" ;;
  esac
  say ERROR "psql rc=$rc: $(printf '%s\n' "$out" | head -n1 | cut -c1-70)" ;;
s3)
  run_curl "user = \"${S3_ACCESS_KEY:-isocheck}:${S3_SECRET_KEY:-isocheck}\"" -I -o /dev/null -m 10 \
    --aws-sigv4 aws:amz:us-east-1:s3 "http://$host:$port/${S3_BUCKET:-filegrid}"
  [ "$rc" = 0 ] || { net_fail; say REACHED "connected, then curl rc=$rc: $(errline)"; }
  [ "$code" = 200 ] && say OK "signed HEAD bucket: HTTP 200"
  say REACHED "server answered HTTP $code" ;;
ftp)
  # PASV (not EPSV) and use the address from the 227 reply: the data connection goes to the pod IP.
  run_curl "user = \"${FTP_USER:-isocheck}:${FTP_PASSWORD:-isocheck}\"" -o /dev/null -m 15 \
    --disable-epsv --no-ftp-skip-pasv-ip "ftp://$host:$port/"
  [ "$rc" = 0 ] || { net_fail; say REACHED "connected, then curl rc=$rc: $(errline)"; }
  set -- $(printf '%s\n' "$out" | sed -n 's/^\* Connected 2nd connection to \([0-9.]*\) port \([0-9]*\).*/\1 \2/p' | tail -n1)
  [ "${1:-}" = "$podip" ] && [ "${2:-0}" -ge 21000 ] && [ "${2:-0}" -le 21009 ] \
    && say OK "LIST, passive data via $1:$2"
  say ERROR "LIST ok but no data connection to $podip:21000-21009 seen" ;;
tcp)
  run_curl '' -m $((T + 1)) "telnet://$host:$port"
  zero "$conn" || say OPEN "TCP handshake completed"
  net_fail ;;
hold)
  # Keep an FTP session whose passive listener sits on $port until the host creates the release file,
  # then connect to that listener to prove it was live all along.
  trap '' PIPE
  d=$(mktemp -d) && mkfifo "$d/in" || say ERROR "mktemp/mkfifo failed"
  nc "$host" 21 <"$d/in" >"$d/out" 2>&1 & ncpid=$!
  exec 3>"$d/in"
  bye() { printf 'QUIT\r\n' >&3 2>/dev/null; exec 3>&-; kill "$ncpid" 2>/dev/null; rm -rf "$d"; }
  send() { printf '%s\r\n' "$1" >&3; }
  want() { i=0; while [ "$(grep -c "^$1 " "$d/out")" -lt "$2" ]; do
             i=$((i + 1)); [ $i -le 100 ] || return 1; sleep 0.05; done; }
  want 220 1 || { bye; say ERROR "no FTP greeting from $host:21"; }
  send "USER ${FTP_USER:-isocheck}"; want 331 1 || { bye; say ERROR "FTP USER not accepted"; }
  send "PASS ${FTP_PASSWORD:-isocheck}"; want 230 1 || { bye; say ERROR "FTP login failed"; }
  n=0
  while :; do
    n=$((n + 1)); [ $n -le 100 ] || { bye; say ERROR "pure-ftpd never offered :$port in 100 PASV"; }
    send PASV; want 227 $n || { bye; say ERROR "no reply to PASV"; }
    set -- $(grep '^227 ' "$d/out" | tail -n1 |
      sed -n 's/.*(\([0-9]*\),\([0-9]*\),\([0-9]*\),\([0-9]*\),\([0-9]*\),\([0-9]*\)).*/\1.\2.\3.\4 \5 \6/p')
    [ "${1:-}" = "$podip" ] || { bye; say ERROR "PASV advertised '${1:-}', not the pod IP"; }
    [ $(( ${2:-0} * 256 + ${3:-0} )) = "$port" ] && break
  done
  echo "ISOCHECK-LISTENING after $n PASV"
  i=0; while [ ! -e "/tmp/isocheck-release-$port" ]; do
    i=$((i + 1)); [ $i -le 600 ] || { bye; say ERROR "never released"; }; sleep 0.1; done
  rm -f "/tmp/isocheck-release-$port"
  run_curl '' -m $((T + 1)) "telnet://$podip:$port"
  bye
  zero "$conn" || say OPEN "held PASV listener accepted the labelled pod"
  net_fail ;;
*) say ERROR "unknown probe mode '$mode'" ;;
esac
EOF

pod_manifest() {   # <client>
  local c=$1 extra=""
  [ "${STORAGE_LABEL[$c]}" = yes ] && extra=', filegrid.io/storage-client: "true"'
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${POD[$c]}
  namespace: ${NS[$c]}
  labels: {app.kubernetes.io/name: isocheck, filegrid.io/isocheck-run: "$RUN"$extra}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 1
  activeDeadlineSeconds: 600
  securityContext: {runAsNonRoot: true, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: pg
      image: $PG_IMAGE
      command: [sleep, "600"]
      envFrom: [{secretRef: {name: $SECRET, optional: true}}]   # the Secret does not exist in default
      securityContext: {runAsUser: 70, runAsGroup: 70, allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 5m, memory: 16Mi}, limits: {memory: 64Mi}}
    - name: curl
      image: $CURL_IMAGE
      command: [sleep, "600"]
      envFrom: [{secretRef: {name: $SECRET, optional: true}}]
      securityContext: {runAsUser: 100, runAsGroup: 101, allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 5m, memory: 16Mi}, limits: {memory: 64Mi}}
EOF
}

exec_raw() {   # <client> <container> <probe args...>: combined output on stdout, kubectl's exit code
  local c=$1 ctr=$2; shift 2
  local pod=${POD[$c]} cmd=(sh -c "$PROBE" isocheck "$@")
  if [ "$c" = def ]; then
    case $FAULT in
      nopod) pod=$pod-missing ;;
      notool) cmd=(isocheck-no-such-tool "$@") ;;
      badtoken) cmd=(sh -c 'echo "ISOCHECK BLOCKED fault-injected"') ;;
    esac
  fi
  timeout "${EXEC_TIMEOUT:-40}" kubectl -n "${NS[$c]}" exec "$pod" -c "$ctr" -- "${cmd[@]}" 2>&1
}

parse_result() {   # <exec rc> <output> -> P_TOKEN P_DETAIL
  local rc=$1 out=$2 n line msg
  n=$(printf '%s\n' "$out" | grep -c '^ISOCHECK ')
  if [ "$rc" -ne 0 ]; then
    msg=$(printf '%s\n' "$out" | grep -v '^ISOCHECK' | grep . | head -n1)
    [ "${#msg}" -le 70 ] || msg="...${msg: -67}"   # the cause is at the end of kubectl's message
    P_TOKEN=INVALID; P_DETAIL="exec failed (rc=$rc): $msg"
    return
  fi
  if [ "$n" -ne 1 ]; then P_TOKEN=INVALID; P_DETAIL="expected 1 result line, got $n"; return; fi
  line=$(printf '%s\n' "$out" | grep '^ISOCHECK ')
  read -r _ P_TOKEN P_DETAIL <<<"$line"
  case $P_TOKEN in
    OK|OPEN|REACHED|REFUSED|TIMEOUT|ERROR) ;;
    *) P_DETAIL="unknown token '$P_TOKEN'"; P_TOKEN=INVALID ;;
  esac
}

probe() { local out rc; out=$(exec_raw "$@"); rc=$?; parse_result "$rc" "$out"; }

add_row() {   # <group> <client> <target> <key> <role>
  ROWS+=("$1$SEP$2$SEP$3$SEP$4$SEP$5$SEP$P_TOKEN$SEP$P_DETAIL")
}

proto_rows() {   # <client> <group> <role>: the real operations against the three Services
  local c=$1 g=$2 role=$3
  probe "$c" pg pg "$PG_HOST" 5432;                add_row "$g" "$c" "postgres:5432 psql SELECT 1" postgres "$role"
  probe "$c" curl s3 "$S3_HOST" 8333;              add_row "$g" "$c" "s3:8333 signed HEAD bucket" s3 "$role"
  probe "$c" curl ftp "$FTP_HOST" 21 "$FTP_IP";    add_row "$g" "$c" "ftp:21 LIST over PASV" ftp "$role"
}

passive_round() {   # <port>: hold a live PASV listener on <port>, probe it from the blocked pods
  local port=$1 f=$TMP/hold-$port pid i rc c n
  HELD[$port]=no
  EXEC_TIMEOUT=120 exec_raw lab curl hold "$FTP_HOST" "$port" "$FTP_IP" >"$f" &
  pid=$!
  for i in $(seq 1 300); do
    grep -q '^ISOCHECK-LISTENING' "$f" && { HELD[$port]=yes; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  for c in unl def; do
    probe "$c" curl tcp "$FTP_IP" "$port"; add_row "$([ $c = unl ] && echo 2 || echo 3)" "$c" "ftp pod :$port live PASV port" "pasv$port" blocked
  done
  kubectl -n "${NS[lab]}" exec "${POD[lab]}" -c curl -- touch "/tmp/isocheck-release-$port" >/dev/null 2>&1
  wait "$pid"; rc=$?
  parse_result "$rc" "$(cat "$f")"
  n=$(sed -n 's/^ISOCHECK-LISTENING after \([0-9]*\) PASV.*/\1/p' "$f")
  if [ "${HELD[$port]}" = yes ]; then P_DETAIL="PASV x$n until :$port; $P_DETAIL"
  else P_DETAIL="listener never confirmed; $P_DETAIL"; fi
  add_row 1 lab "ftp pod :$port held PASV port" "pasv$port" hold
}

FTP_IP=$(kubectl -n "$STORE" get pod ftp-0 -o jsonpath='{.status.podIP}' 2>/dev/null)
[ -n "$FTP_IP" ] || { echo "ISOLATION CHECK FAILED: ftp-0 pod IP not found (is the storage up?)"; exit 1; }

echo "Storage isolation check (run $RUN, ftp-0 pod IP $FTP_IP)"
[ -n "$FAULT" ] && echo "*** FAULT INJECTION ACTIVE: ISOCHECK_FAULT=$FAULT, this run must FAIL ***"

for c in lab unl def; do
  POD[$c]=isocheck-$RUN-$c
  pod_manifest "$c" | kubectl apply -f - >/dev/null || echo "could not create ${NS[$c]}/${POD[$c]}"
done
for c in lab unl def; do
  kubectl -n "${NS[$c]}" wait --for=condition=Ready "pod/${POD[$c]}" --timeout=120s >/dev/null 2>&1 \
    || echo "warning: client pod ${NS[$c]}/${POD[$c]} is not Ready (its rows will fail)"
done

echo "probing (positive control, blocked clients, passive ports, control re-check) ..."
proto_rows lab 1 control
proto_rows unl 2 blocked
proto_rows def 3 blocked
for port in "${PASV_PORTS[@]}"; do passive_round "$port"; done
proto_rows lab 4 recheck

# Controls first: a target counts as live only if the labelled pod proved it before AND after.
for r in "${ROWS[@]}"; do
  IFS=$SEP read -r g c target key role token detail <<<"$r"
  case $role in
    control) [ "$token" = OK ] && BEFORE[$key]=1 ;;
    recheck) [ "$token" = OK ] && AFTER[$key]=1 ;;
    hold) [ "$token" = OPEN ] && [ "${HELD[${key#pasv}]}" = yes ] && { BEFORE[$key]=1; AFTER[$key]=1; } ;;
  esac
done

FAILS=0 TOTAL=0
fmt='%-30s %-31s %-15s %-8s %-6s %s\n'
echo
printf "$fmt" CLIENT TARGET EXPECTED GOT RESULT DETAIL
for g in 1 2 3 4; do
  for r in "${ROWS[@]}"; do
    IFS=$SEP read -r rg c target key role token detail <<<"$r"
    [ "$rg" = "$g" ] || continue
    verdict=FAIL
    case $role in
      control|recheck) expect=OK; [ "$token" = OK ] && verdict=PASS ;;
      hold) expect=OPEN; [ "$token" = OPEN ] && [ "${HELD[${key#pasv}]}" = yes ] && verdict=PASS ;;
      blocked)
        expect=REFUSED/TIMEOUT
        case $token in
          REFUSED|TIMEOUT)
            if [ -n "${BEFORE[$key]:-}" ] && [ -n "${AFTER[$key]:-}" ]; then verdict=PASS
            else detail="$detail; NOT TRUSTED: target not proven live by the labelled pod"; fi ;;
        esac ;;
    esac
    who=${DESC[$c]}; [ "$role" = recheck ] && who="$who (re-check)"
    TOTAL=$((TOTAL + 1)); [ "$verdict" = PASS ] || FAILS=$((FAILS + 1))
    printf "$fmt" "$who" "$target" "$expect" "$token" "$verdict" "$detail"
  done
done
echo
echo "Blocked = REFUSED or TIMEOUT on a port the labelled pod proved live in this run (before and after);"
echo "kube-router rejects denied traffic with ICMP port-unreachable, seen by the client as 'connection refused'."
if [ "$FAILS" -eq 0 ]; then
  echo "ISOLATION OK: $TOTAL/$TOTAL checks passed"
  exit 0
fi
echo "ISOLATION CHECK FAILED: $FAILS of $TOTAL checks failed"
exit 1
