#!/usr/bin/env bash
# Recreate the offline-harness module shims for pi-auto-rename.
# The harness mocks @earendil-works/pi-coding-agent (getAgentDir) and
# @earendil-works/pi-tui, guards @earendil-works/pi-ai/compat, and runs the
# naming call against the mock ctx.modelRegistry.complete() in run-tests.mjs
# (no network, no real provider keys). @types/node is provided for tsc.
# Run from the repo root:  bash .harness/setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/node_modules/@earendil-works" "$ROOT/node_modules/@types"
ln -sfn ../../.harness/shim/pi-ai "$ROOT/node_modules/@earendil-works/pi-ai"
ln -sfn ../../.harness/shim/pi-coding-agent "$ROOT/node_modules/@earendil-works/pi-coding-agent"
ln -sfn ../../.harness/shim/pi-tui "$ROOT/node_modules/@earendil-works/pi-tui"

# Find a locally installed @types/node. The pnpm store path is version-pinned
# and has moved across pnpm releases, so try the known locations in order and
# allow an explicit override for other machines.
find_types_node() {
  if [[ -n "${ARN_TYPES_NODE:-}" && -d "$ARN_TYPES_NODE" ]]; then
    echo "$ARN_TYPES_NODE"
    return
  fi
  local candidate
  for candidate in \
    "$HOME"/.local/share/pnpm/global/*/.pnpm/@types+node@*/node_modules/@types/node \
    "$HOME"/.local/share/pnpm/global/5/.pnpm/@types+node@*/node_modules/@types/node \
    "$HOME"/services/pi-web/dist/node_modules/@types/node; do
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
}
TYPES_NODE="$(find_types_node)"
if [[ -z "$TYPES_NODE" ]]; then
  echo "setup.sh: no @types/node found; set ARN_TYPES_NODE to its directory" >&2
  exit 1
fi
ln -sfn "$TYPES_NODE" "$ROOT/node_modules/@types/node"

echo "shims ready. Run in an isolated temp home, e.g.:"
echo "  ~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-offline -- bash -c 'export HOME=\"\$(mktemp -d \"\$PI_TASK_TMPDIR/home.XXXXXX\")\"; node .harness/run-tests.mjs'"
echo "Typecheck: cd .harness && npx --yes -p typescript@5.9.2 tsc -p tsconfig.check.json"
