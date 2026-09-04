#!/usr/bin/env bash
# Reproduce the single scenario the article is built around: the provider
# applies the charge and the response never arrives.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== provider succeeds, response lost, client retries, reconciliation resolves =="
node --test-name-pattern "T4" --test tests/conformance.test.ts
echo
echo "== raw evidence =="
cat results/t4-lost-response-reconciled.json
