# Acceptance and independent review

Date: 2026-10-06. Branch: `fix/nonblocking-auto-naming`. This verification report was captured before delivery commits. The user subsequently approved committing the related changes, archiving the task, and opening a draft PR.

## Outcome

Automatic first naming and continuous renaming no longer return or await title-provider completion from session/message/settlement handlers. Jobs reserve ownership synchronously and dispatch in contained background work. Request lifetime is independently bounded to 30 seconds, including a noncooperative provider. Active request identity, lifecycle generation, and name epoch protect success/error/cooldown/finalizers; explicit `/rename` remains awaited and supersedes background work.

All six PRD acceptance criteria passed. The independent checker reported no remaining blocking issues after local corrections.

## Actual verification

| Check | Result and coverage |
|---|---|
| Original implementation offline suite | 182 passed, 0 failed |
| Independent strengthened full offline suite | **254 passed, 0 failed** |
| Typecheck | PASS, TypeScript 5.9.3 against available Pi 1.0.0 declarations |
| Registry routing E2E | PASS on installed standalone Pi CLI 1.0.2, custom API provider |
| Nonblocking E2E: eventual title | Tool execution and next main model request precede title completion/application |
| Nonblocking E2E: never-completing title | Main model/tool progression, settlement, and clean process exit; valid session without title/state writes |
| Awaited-handler mutation | Targeted T12's three automatic-handler nonblocking assertions all fail intentionally: 7 passed, 3 failed |
| E2E missing-session negative fixture | Both scenarios fail even when fake progress logs exist |
| Watchdog negative tests | Invalid/overflow inputs rejected; hanging fixtures fail twice with status 124 |
| Syntax/whitespace/context | `node --check`, `bash -n`, `git diff --check`, and Trellis context validation PASS |

The offline harness checks unhandled late rejection, deadline timer cleanup, direct listener counts, old/new owners, invalid contexts/session identities, ordinary appends, historical branches, manual clear/ABA/supersession/failure, configuration disable, and original registry/manual/cooldown/continuous behavior.

The project has no separately configured lint command. No claim is made that current typechecking/CLI tests execute every supported historical runtime. Required shutdown/tree/session-identity/registry APIs were checked separately in official v0.84.0 source; minimum-version source compatibility is not full 0.84 runtime coverage.

## Reproducible commands

Offline suite with a unique HOME, because the harness writes configuration:

```bash
/home/xupeng/.pi/agent/bin/pi-tmp-run --keep-on-failure check-auto-rename-offline-final -- \
  bash -c 'set -o pipefail; export HOME="$(mktemp -d "$PI_TASK_TMPDIR/home.XXXXXX")"; node .harness/run-tests.mjs | tail -2'
```

Typecheck used an already installed compiler without downloading dependencies:

```bash
/home/xupeng/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-types -- \
  bash -c 'export HOME="$(mktemp -d "$PI_TASK_TMPDIR/home.XXXXXX")"; node /home/xupeng/.local/share/personal-assistant/releases/memory-532ca47/node_modules/typescript/bin/tsc -p .harness/tsconfig.check.json'
```

The initial attempt to locate an npm-offline compiler returned ENOTCACHED; the installed 5.9.3 compiler above was then found and used successfully. No dependency upgrade/download was needed.

Real-runtime scenarios:

```bash
PI_BIN=/home/xupeng/.local/share/mise/installs/pi/1.0.2/pi/pi \
  /home/xupeng/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-registry -- \
  bash .harness/e2e-registry-naming.sh

PI_BIN=/home/xupeng/.local/share/mise/installs/pi/1.0.2/pi/pi \
  /home/xupeng/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-nonblocking -- \
  bash .harness/e2e-nonblocking-naming.sh

node --check .harness/run-tests.mjs
bash -n .harness/setup.sh .harness/e2e-registry-naming.sh .harness/e2e-nonblocking-naming.sh
git diff --check
```

Both E2E scripts require pi-tmp-run's PI_TASK_TMPDIR, use isolated HOME/agent/work/session directories, set PI_OFFLINE=1, and rely on faux providers rather than external model services. Parent watchdogs are shorter than the 30-second product deadline; cleanup terminates/reaps only test-owned process groups. JSONL validation is structural and missing/corrupt evidence cannot pass.

## Review findings fixed

1. Missing-session E2E could falsely pass the never-finishing scenario; assertions now require valid session/probe/follow-up evidence and no naming state.
2. Watchdog values and cleanup were too permissive; values are restricted to 1-29 seconds, overflow is rejected, and process-group cleanup is owned and bounded.
3. Listener/finalizer/context/manual/config tests were strengthened rather than relying only on cooperative cancellation or plain name equality.
4. Unused diagnostic request counters were removed; object identity remains the actual ownership guard.
5. Initial fake-provider detection incorrectly read provider context.systemPrompt. Provider requests carry normalized transcript system messages; shared detection now uses getSystemMessageText.

The final Pi extension spec documents these executable ownership/deadline/event-order contracts, not only a general promise of background work.

## Resource closeout

Implementation and review verified their actual TMPDIR roots under `/home/xupeng/.cache/pi-tmp/`. All task-created verification sandboxes, negative fixtures/mutations, failed compiler workspaces, and test processes were removed after recording these results. Parent process inspection found no matching test processes remaining.

No task-owned validation workspace remains to retain or clean later. Wrapper-managed shared jiti/node-compile-cache directories were not broadly deleted and remain governed by the wrapper cache policy; they contain no unique acceptance evidence.

## Git scope and baseline preservation

Preserved prior registry migration and existing E2E work. Product changes: `index.ts`, `naming.ts`, `README.md`. Harness changes/new fixtures are limited to offline/typecheck setup, registry-routing E2E, nonblocking E2E, shared request detection, and their settings. `.codegraph/` is unrelated and must stay out of task commits unless separately requested.

Trellis artifacts/specs are ignored by current Git rules. When committing them, explicitly force-add only this task's planning/research/acceptance files and the intended Pi extension spec files, not runtime state, caches, or unrelated bootstrap task work. Archive/journal commits must stay on the task feature branch and accompany the task PR, never be added later on main.
