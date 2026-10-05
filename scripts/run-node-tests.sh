#!/bin/sh
# Runs `node --test-reporter=tap "$@"` and fails when node fails OR when any test or suite reports `not ok`.
# node --test exits 0 when a describe() body throws (measured on Node 22: the suite prints `not ok`, the summary
# counts it nowhere), so a spec that cannot even load would pass test:unit and test:money without this check.
# Usage: sh scripts/run-node-tests.sh -r ts-node/register --test <spec>...

set -u

out=$(mktemp)
rc=$(mktemp)
trap 'rm -f "$out" "$rc"' EXIT

{
  node --test-reporter=tap "$@"
  echo $? >"$rc"
} 2>&1 | tee "$out"

code=$(cat "$rc")
if [ "$code" != "0" ]; then
  exit "$code"
fi
if grep -Eq '^[[:space:]]*not ok' "$out"; then
  echo "run-node-tests: node exited 0, but these tests or suites report not ok:" >&2
  grep -E '^[[:space:]]*not ok' "$out" >&2
  exit 1
fi
