#!/usr/bin/env bash
# Helpers for the shell-script tests (scripts/tests/*.test.sh, run by `make scripts-test`). No cluster needed:
# every test runs in its own subshell with a sandbox directory whose bin/ (first on PATH) holds fake kubectl /
# helm / k3s / systemctl / docker commands. The fakes keep their state under $FAKE_STATE and append every argv
# to $FAKE_STATE/calls, so a test can check what was run (and that no secret value ever reached a command line).
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FAKES=$REPO/scripts/tests/fakes

fail() { printf '    FAIL: %s\n' "$*"; TEST_FAILED=1; }
assert_eq() {   # <actual> <expected> [what]
  [ "$1" = "$2" ] || fail "${3:-value}: expected '$2', got '$1'"
}
assert_contains() {   # <haystack> <needle> [what]
  grep -qF -- "$2" <<<"$1" || fail "${3:-output} does not contain '$2'"
}
assert_not_contains() {   # <haystack> <needle> [what]
  [ -n "$2" ] || { fail "${3:-output}: empty needle"; return; }
  ! grep -qF -- "$2" <<<"$1" || fail "${3:-output} contains '$2'"
}
assert_status() {   # <actual exit status> <expected> [what]
  [ "$1" -eq "$2" ] || fail "${3:-exit status}: expected $2, got $1"
}

# Sandbox with the given fakes linked into bin/ (fake-<name> becomes <name>).
sandbox() {   # <fake names...>
  SANDBOX=$(mktemp -d)
  FAKE_STATE=$SANDBOX/state
  mkdir -p "$SANDBOX/bin" "$FAKE_STATE"
  : > "$FAKE_STATE/calls"
  local f
  for f in "$@"; do ln -s "$FAKES/fake-$f" "$SANDBOX/bin/$f"; done
  export FAKE_STATE PATH="$SANDBOX/bin:$PATH"
}

calls() { cat "$FAKE_STATE/calls"; }
count_calls() { grep -c -- "$1" "$FAKE_STATE/calls" || true; }

run_tests() {
  local t failed=0 total=0
  for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
    total=$((total + 1))
    if ( TEST_FAILED=0; "$t"; rm -rf "${SANDBOX:-/nonexistent}"; exit "$TEST_FAILED" ); then
      printf '  ok    %s\n' "$t"
    else
      printf '  FAIL  %s\n' "$t"
      failed=$((failed + 1))
    fi
  done
  printf '%s: %d/%d passed\n' "$(basename "$0")" "$((total - failed))" "$total"
  [ "$failed" -eq 0 ]
}
