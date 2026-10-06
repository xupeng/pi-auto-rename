#!/usr/bin/env bash
# Real-runtime E2E: naming must work for a provider whose models use a custom
# api id registered by an extension.
#
# Why this exists: the offline harness mocks ctx.modelRegistry.complete, so it
# cannot prove that the *real* pi runtime routes a provider-extension api id
# (cliproxyapi's "cliproxyapi-codex-responses" was the original case) through the
# composed provider. This script boots the real `pi` binary against a sandbox
# agent dir, a faux provider extension with api id "fauxapi-custom-responses", and
# zero pi-auto-rename config (naming follows the session model).
#
# Pass: the session gets an automatic name. Fail (pre-registry code): pi-ai/compat
# throws "No API provider registered for api: fauxapi-custom-responses" and the
# session stays unnamed.
#
# Requires: `pi` on PATH. No network access.
# Run via pi-tmp-run, with PI_BIN pointing to the CLI to validate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/.harness"
PI_BIN="${PI_BIN:-$(command -v pi || true)}"
if [[ -z "$PI_BIN" || ! -x "$PI_BIN" || -z "${PI_TASK_TMPDIR:-}" ]]; then
  echo "FAIL  executable PI_BIN and pi-tmp-run's PI_TASK_TMPDIR are required" >&2
  exit 1
fi
SANDBOX="$(mktemp -d "$PI_TASK_TMPDIR/pi-arn-e2e.XXXXXX")"
EXPECTED_TITLE="Faux 自定义 API 标题"
PI_PID=""

stop_child() {
  if [[ -n "$PI_PID" ]]; then
    if kill -0 -- "-$PI_PID" 2>/dev/null; then
      kill -TERM -- "-$PI_PID" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$PI_PID" 2>/dev/null || true
    else
      kill "$PI_PID" 2>/dev/null || true
    fi
    wait "$PI_PID" 2>/dev/null || true
    PI_PID=""
  fi
}

cleanup() {
  local status=$?
  stop_child
  if (( status != 0 )); then KEEP=1; fi
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "sandbox kept: $SANDBOX"
  else
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SANDBOX/agent" "$SANDBOX/sessions" "$SANDBOX/work" "$SANDBOX/home"
cp "$HARNESS/e2e/settings.json" "$SANDBOX/agent/settings.json"

echo "=== E2E: provider-extension api id naming (sandbox: $SANDBOX) ==="
(
  cd "$SANDBOX/work"
  HOME="$SANDBOX/home" PI_CODING_AGENT_DIR="$SANDBOX/agent" PI_OFFLINE=1 \
  exec timeout --signal=TERM --kill-after=2s 20s "$PI_BIN" -p \
    --model fauxapi/naming-model \
    --session-dir "$SANDBOX/sessions" \
    -e "$ROOT/index.ts" \
    -e "$HARNESS/e2e/faux-provider.ts" \
    -nc -ns -np -- "你好，请只回复 ok"
) &
PI_PID=$!
status=0
wait "$PI_PID" || status=$?
stop_child
if (( status != 0 )); then
  echo "  FAIL  pi run failed with status $status (see output above)"
  exit 1
fi

SESSION_FILE="$(find "$SANDBOX/sessions" -name '*.jsonl' | sort | tail -1)"
if [[ -z "$SESSION_FILE" ]]; then
  echo "  FAIL  no session file written under $SANDBOX/sessions"
  exit 1
fi

# Structural check: the auto-name state entry carries the expected title and the
# persisted session_info name matches. A plain grep could pass on an unrelated
# occurrence of the title or the entry type string.
if python3 - "$SESSION_FILE" "$EXPECTED_TITLE" <<'PY'
import json, sys
path, expected = sys.argv[1], sys.argv[2]
state, title = None, None
for line in open(path, encoding="utf-8"):
    if not line.strip():
        continue
    entry = json.loads(line)
    if entry.get("type") == "custom" and entry.get("customType") == "pi-auto-rename:state":
        state = entry.get("data") or {}
    if entry.get("type") == "session_info" and entry.get("name"):
        title = entry["name"]
sys.exit(0 if (state and state.get("source") == "auto" and state.get("name") == expected and title == expected) else 1)
PY
then
  echo "  PASS  session auto-named through the registry: $EXPECTED_TITLE"
  exit 0
fi

echo "  FAIL  session was not named (provider-extension api id regression?)"
echo "        session: $SESSION_FILE"
exit 1
