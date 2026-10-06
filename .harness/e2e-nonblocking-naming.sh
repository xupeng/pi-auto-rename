#!/usr/bin/env bash
# Real-runtime E2E: automatic session naming must not block Agent progress.
#
# Requires: `pi` on PATH (installed CLI), no network. Run through pi-tmp-run so
# TMPDIR/PI_TASK_TMPDIR are the session-scoped temp dir (never /tmp):
#
#   ~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-e2e -- \
#     bash .harness/e2e-nonblocking-naming.sh
#
# Scenario 1 — progress + eventual naming:
#   The title provider holds the request until the second main model request
#   releases it. A probe tool proves the agent reached tool execution while the
#   title was pending; the second main request proves it progressed again before
#   the release. The test provider then waits for the applied-title latch so
#   print-mode exit cannot race the naming.
#
# Scenario 2 — never-finishing title:
#   The title provider never settles. The agent still finishes, the process exits
#   within the watchdog, and no title is written.
#
# A parent watchdog shorter than the product's 30s deadline makes the old
# awaited-handler implementation fail promptly instead of "passing" after its
# own timeout. Only this test's timeout child and its process group are signalled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/.harness"
PI_BIN="${PI_BIN:-$(command -v pi || true)}"
if [[ -z "$PI_BIN" || ! -x "$PI_BIN" ]]; then
  echo "FAIL  no executable pi found (set PI_BIN)" >&2
  exit 1
fi
if [[ -z "${PI_TASK_TMPDIR:-}" ]]; then
  echo "FAIL  PI_TASK_TMPDIR is not set; run via ~/.pi/agent/bin/pi-tmp-run" >&2
  exit 1
fi

WATCHDOG="${E2E_WATCHDOG_SECONDS:-20}"   # must stay below the 30s product deadline
if [[ ! "$WATCHDOG" =~ ^([1-9]|1[0-9]|2[0-9])$ ]]; then
  echo "FAIL  E2E_WATCHDOG_SECONDS must be an integer from 1 to 29" >&2
  exit 1
fi
SANDBOX="$(mktemp -d "$PI_TASK_TMPDIR/pi-arn-np.XXXXXX")"
KEEP="${KEEP:-0}"
PI_PID=""

stop_child() {
  if [[ -n "$PI_PID" ]]; then
    # GNU timeout owns this process group (including Pi). Also handle a trap
    # before timeout had time to create the group, and reap the direct child.
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
  if [[ "$KEEP" == "1" ]]; then
    echo "sandbox kept: $SANDBOX"
  else
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

FAILURES=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# Verify markers appear in this exact order in a progress log.
order_ok() {
  local file="$1"; shift
  if [[ ! -s "$file" ]]; then
    fail "missing or empty progress log: $file"
    return 1
  fi
  local prev=0 token line
  for token in "$@"; do
    line="$(grep -n -m1 -x "$token" "$file" | cut -d: -f1 || true)"
    if [[ -z "$line" ]]; then
      fail "missing progress marker: $token"
      return 1
    fi
    if (( line <= prev )); then
      fail "out-of-order progress marker: $token"
      return 1
    fi
    prev="$line"
  done
  return 0
}

# Structurally assert the session JSONL: the auto-name state entry exists with
# the expected name and the persisted session_info title matches.
session_assert_named() {
  local file="$1" expected="$2"
  python3 - "$file" "$expected" <<'PY'
import json, sys
path, expected = sys.argv[1], sys.argv[2]
state, title = None, None
entries = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
probe_index, state_index = None, None
for index, entry in enumerate(entries):
    message = entry.get("message", {})
    if message.get("role") == "toolResult" and message.get("toolName") == "e2e_probe" and not message.get("isError"):
        probe_index = index
    if entry.get("type") == "custom" and entry.get("customType") == "pi-auto-rename:state":
        state = entry.get("data") or {}
        state_index = index
    if entry.get("type") == "session_info" and entry.get("name"):
        title = entry["name"]
ok = (bool(entries) and entries[0].get("type") == "session" and bool(state)
      and state.get("source") == "auto" and state.get("name") == expected and title == expected
      and probe_index is not None and state_index is not None and probe_index < state_index)
sys.exit(0 if ok else 1)
PY
}

# Require actual persisted tool/main progress, not merely absence of a title.
session_assert_unnamed() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, sys
entries = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
if not entries or entries[0].get("type") != "session":
    sys.exit(1)
probe_index, done_index = None, None
for index, entry in enumerate(entries):
    message = entry.get("message", {})
    if message.get("role") == "toolResult" and message.get("toolName") == "e2e_probe" and not message.get("isError"):
        probe_index = index
    if message.get("role") == "assistant" and any(block.get("text") == "done" for block in message.get("content", [])):
        done_index = index
    if entry.get("type") == "custom" and entry.get("customType") == "pi-auto-rename:state":
        sys.exit(1)
    if entry.get("type") == "session_info" and entry.get("name"):
        sys.exit(1)
sys.exit(0 if probe_index is not None and done_index is not None and probe_index < done_index else 1)
PY
}

run_scenario() {
  local name="$1" title_mode="$2" wait_for_title="$3"
  local dir="$SANDBOX/$name"
  mkdir -p "$dir/agent" "$dir/sessions" "$dir/work" "$dir/latch" "$dir/home"
  cp "$HARNESS/e2e/nonblocking-settings.json" "$dir/agent/settings.json"

  echo "=== E2E scenario: $name (title mode: $title_mode) ==="
  (
    cd "$dir/work"
    E2E_LATCH_DIR="$dir/latch" E2E_TITLE_MODE="$title_mode" E2E_WAIT_FOR_TITLE="$wait_for_title" \
    HOME="$dir/home" PI_CODING_AGENT_DIR="$dir/agent" PI_OFFLINE=1 \
    exec timeout --signal=TERM --kill-after=2s "${WATCHDOG}s" "$PI_BIN" -p \
      --model e2enp/np-model \
      --session-dir "$dir/sessions" \
      -e "$ROOT/index.ts" \
      -e "$HARNESS/e2e/nonblocking-provider.ts" \
      -nc -ns -np -- "请回复 ok" >"$dir/pi.log" 2>&1
  ) &
  PI_PID=$!
  local status=0
  wait "$PI_PID" || status=$?
  stop_child

  if [[ "$status" -ne 0 ]]; then
    fail "$name: pi exited with status $status (124/137 = watchdog killed a blocked run)"
    sed -n '1,40p' "$dir/pi.log" | sed 's/^/        /'
    return 1
  fi
  pass "$name: pi exited cleanly within ${WATCHDOG}s"
  return 0
}

# ---------------------------------------------------------------------------
# Scenario 1: tool + next model request progress while the title is pending,
# then the title is eventually applied.
# ---------------------------------------------------------------------------
if run_scenario "progress-and-name" "release" "1"; then
  D1="$SANDBOX/progress-and-name"
  LOG1="$D1/latch/progress.log"
  if order_ok "$LOG1" "naming-started" "tool-saw-naming-pending" "main2-started" "title-released" "title-applied" "main2-saw-title"; then
    pass "progress-and-name: tool and next main request ran before the title was applied"
  fi
  SESSION_FILE="$(find "$D1/sessions" -name '*.jsonl' | sort | tail -1 || true)"
  if [[ -n "$SESSION_FILE" ]] && session_assert_named "$SESSION_FILE" "E2E 后台标题"; then
    pass "progress-and-name: session was named through the background request"
  else
    fail "progress-and-name: session not named (session file: ${SESSION_FILE:-none})"
  fi
fi

# ---------------------------------------------------------------------------
# Scenario 2: a never-finishing title must not block Agent progress or shutdown.
# ---------------------------------------------------------------------------
if run_scenario "never-finishing" "never" "0"; then
  D2="$SANDBOX/never-finishing"
  LOG2="$D2/latch/progress.log"
  if order_ok "$LOG2" "naming-started" "tool-saw-naming-pending" "main2-started" "shutdown-with-title-pending"; then
    pass "never-finishing: agent executed the tool and the next request with the title pending"
  fi
  if grep -q -x "title-applied" "$LOG2"; then
    fail "never-finishing: a title was applied even though the provider never settled"
  else
    pass "never-finishing: no title was applied"
  fi
  SESSION_FILE="$(find "$D2/sessions" -name '*.jsonl' | sort | tail -1 || true)"
  if [[ -n "$SESSION_FILE" ]] && session_assert_unnamed "$SESSION_FILE"; then
    pass "never-finishing: no stale naming state persisted"
  else
    fail "never-finishing: missing/invalid session or stale title/state persisted (session file: ${SESSION_FILE:-none})"
  fi
fi

if (( FAILURES > 0 )); then
  echo "E2E FAILED: $FAILURES check(s)"
  exit 1
fi
echo "E2E PASSED"
