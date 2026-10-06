# Implementation plan

## Phase gate

Do not begin product edits or run `task.py start` until the user explicitly approves the latest final planning summary in a subsequent message. Creation consent does not satisfy this gate.

## Ordered work

1. Snapshot dirty paths and preserve the existing registry migration/E2E WIP. Work on a task feature branch before any commits; do not stage unrelated `.codegraph/` data. Confirm the installed CLI, type declarations, and `TMPDIR` actually used by delegated tools.
2. Implement bounded request lifetime in `naming.ts`: owned controller, independent 30-second deadline, explicit signal forwarding, local completion/cancellation race, and unconditional listener/timer cleanup. Keep registry routing and existing result sanitization.
3. Introduce narrowly scoped session/branch/request ownership in `index.ts`. Replace awaited automatic work with synchronously reserved, deferred background work. Ensure success, failure, notifications, cooldown, and finalizers all check freshness.
4. Wire shutdown, branch navigation, manual supersession, and mode-disable invalidation. Preserve normal-message validity, title ownership, existing thresholds, and manual-name restoration. Protect awaited `/rename` from stale session/branch/name results without changing its interaction.
5. Expand the offline harness with realistic identities and deterministic unresolved/abort-ignoring requests. Keep existing assertions and explicitly assert that each automatic handler finishes before title resolution; add old-owner/new-owner and stale-error tests.
6. Adapt the custom-provider E2E to prove a tool and subsequent main request progress while the title is pending, then validate eventual naming. Add a never-completing-title exit/cleanup scenario. Use latches/structured JSONL and a sub-30-second parent watchdog, not timing guesses.
7. Restore a usable typecheck resolution only if existing missing 0.85.1 paths prevent validation. Prefer available installed declarations with documented resolution; do not silently change advertised minimum compatibility or download/upgrade unrelated dependencies.
8. Update README and Pi extension spec with background timing, strict local deadline/cancellation, stale-owner protections, and print-mode shutdown behavior. Do not promote runtime-specific claims beyond the evidence.
9. Run full-scope quality review, verify task-owned resource cleanup and dirty-file scope, then report acceptance evidence. Commit/push/archive remain separate user-authorized finish actions.

## Test matrix

| Area | Required evidence |
|---|---|
| `session_start`, `message_end`, `agent_settled` | Each handler settles while provider completion is unresolved |
| Primary Agent | Tool execution and next main model request occur while title is pending |
| Single flight | Repeated events during pending request do not launch duplicates |
| Cancellation | Shutdown/switch/reload/tree/manual/mode-disable invalidates only the affected naming owner |
| Stale continuation | Old success/error/rejection/finally does not mutate current session or release a newer owner |
| Deadline | With/without external signal and abort-ignoring provider, local request ends at 30 seconds |
| Cleanup | No leftover task timers/listeners or unhandled late rejection; child process/watchdog/sandbox cleaned |
| Ownership | Normal message/entry append does not make a still-valid title stale |
| Manual command | Awaited `/rename` still works; later rename or session/branch change wins |
| Regression | Manual flag, state restore, cooldown, continuous interval/message gates, KEEP, prompts, config, registry/custom API IDs stay green |
| Print exit | Never-finishing title cannot delay Agent settlement or process shutdown |

## Validation commands and isolation

Resolve the installed CLI explicitly before runtime tests. Planning found:

```text
/home/xupeng/.local/share/mise/installs/pi/1.0.2/pi/pi
```

Use the session-aware wrapper for verification and let scripts allocate only within its temporary directory:

```bash
~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-offline -- \
  bash -c 'export HOME="$(mktemp -d "$PI_TASK_TMPDIR/home.XXXXXX")"; node .harness/run-tests.mjs'

# Execute after correcting missing declaration paths, using the actual resolved compiler.
~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-types -- \
  bash -c 'cd .harness; npx --yes -p typescript@5.9.2 tsc -p tsconfig.check.json'

~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-e2e -- \
  bash .harness/e2e-registry-naming.sh

git diff --check
git status --short
```

The compiler command may require network access solely to obtain TypeScript if absent; prefer an already available equivalent compiler when possible, and do not describe that step as entirely offline. The provider tests themselves must not use external services.

When a sandbox must remain for failure investigation, report its exact path and retention/cleanup plan. Move deliverable evidence into this task's formal artifacts instead of keeping its only copy in auto-cleaned cache. No large repo copies, browser profiles, broad process kills, or temporary `/tmp/<project>` directories. Successful verification leaves no task-owned processes or sandboxes.

## Quality and rollback checks

- Read the curated implementation/check contexts before work; check all touched layers, not only the most recent edit.
- Prove the nonblocking regression tests fail on the old awaited design; do not count an eventual title alone as nonblocking evidence.
- Check race tests against providers that ignore abort, not only cooperative mocks.
- Ensure no `ctx.abort()` or primary controller abort is used for naming cleanup.
- No unchanged leaf-ID requirement, no stale context access before freshness checks, and no old `finally` resetting a newer `inFlight`.
- No title/cooldown/notification writes after session/branch/name ownership is invalid.
- Verify actual runtime versus typecheck version differences and document minimum-version evidence or a compatible fallback. Re-review scope if an API requirement forces a version change.
- Revert only task-owned hunks if necessary; retain baseline uncommitted registry changes and E2E fixtures.
