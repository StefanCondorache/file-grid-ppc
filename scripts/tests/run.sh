#!/usr/bin/env bash
# Runs every scripts/tests/*.test.sh (make scripts-test). Needs bash, jq, openssl, make; no cluster, no root.
set -uo pipefail
cd "$(dirname "$0")"
failed=0
for t in ./*.test.sh; do
  echo "== ${t#./}"
  bash "$t" || failed=$((failed + 1))
done
[ "$failed" -eq 0 ] && echo "scripts-test: all test files passed" || { echo "scripts-test: $failed test file(s) failed"; exit 1; }
