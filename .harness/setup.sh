#!/usr/bin/env bash
# Recreate the offline-harness module shims for pi-auto-rename.
# The harness replaces @earendil-works/pi-ai/compat with a mock `complete`
# (no network, no real provider keys) and @earendil-works/pi-coding-agent
# with a getAgentDir() mock; @types/node is provided for tsc.
# Run from the repo root:  bash .harness/setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/node_modules/@earendil-works" "$ROOT/node_modules/@types"
ln -sfn ../../.harness/shim/pi-ai "$ROOT/node_modules/@earendil-works/pi-ai"
ln -sfn ../../.harness/shim/pi-coding-agent "$ROOT/node_modules/@earendil-works/pi-coding-agent"
ln -sfn /home/xupeng/.local/share/pnpm/global/5/.pnpm/@types+node@26.3.0/node_modules/@types/node "$ROOT/node_modules/@types/node"
echo "shims ready. Run: HOME=/tmp/pi-arn-test-home node .harness/run-tests.mjs"
echo "Typecheck: cd .harness && npx --yes -p typescript@5.9.2 tsc -p tsconfig.check.json"
ln -sfn ../../.harness/shim/pi-tui "$ROOT/node_modules/@earendil-works/pi-tui"
