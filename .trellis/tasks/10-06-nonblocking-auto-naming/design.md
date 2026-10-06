# Design: Non-blocking automatic session naming

## Change boundary

The gap is awaited auxiliary model latency on lifecycle handlers, plus cancellation and ownership that are insufficient once those handlers return early. The behavior lives in the event/request ownership in `index.ts` and the request lifetime in `naming.ts`, not in Pi or the provider implementation.

Expected product files: `index.ts`, `naming.ts`, `README.md`; tests: `.harness/run-tests.mjs`, `.harness/e2e-registry-naming.sh`, `.harness/e2e/faux-provider.ts`, and narrowly scoped new E2E helpers only if necessary. Update `.trellis/spec/pi-extensions/extension-api.md` with verified background-work contracts. The stale local typecheck paths may need a narrow harness configuration/setup correction to make validation executable; do not redesign dependency management.

Do not revert the registry migration, change prompts/config schema/thresholds, add a worker process, or change explicit `/rename` into a background interaction.

## 1. Separate event dispatch from title work

- Automatic lifecycle handlers initialize/check state, reserve a request synchronously, schedule the job, and return without returning the job Promise.
- Defer actual provider dispatch off the handler's synchronous stack, preferably to the next event-loop turn. Capture model/registry, configuration, text, and name ownership before context replacement can occur.
- Keep first-naming and continuous-renaming eligibility gates unchanged. Reserve ownership before scheduling so multiple messages cannot enqueue duplicate work.
- Background success/error paths are contained. No detached Promise may reject unobserved, including failures in metadata updates or notifications.
- Preserve current prompt material from the persisted branch. `message_end` arrives before its message is persisted; do not assume a microtask can observe the final entry, or introduce an unrelated early-message/replacement semantic change.

## 2. Request ownership and freshness

Use one small request-owner abstraction inside the extension rather than a general task scheduler. Each request captures:

- the session ID, session/branch generation, and stable state object;
- a unique request token and owned AbortController;
- the title and name revision at launch;
- naming kind and immutable model/config/input data;
- its scheduled-start handle when applicable.

Before success mutation, warning/error notification, cooldown updates, or cleanup, verify the owner is still current. A stale request must perform no session-dependent side effects. Its `finally` must not release a newer owner's single-flight guard.

Check current name/manual ownership after every asynchronous boundary. If an old context was invalidated by reload/replacement, the local owner check must reject it before touching context getters or `pi` mutators.

Normal Agent message appends must not invalidate a request. Do not compare leaf IDs for strict equality: messages, session metadata, and custom entries all advance the leaf. Use lifecycle/branch generation and, if needed, branch lineage rather than a frozen leaf ID.

## 3. Session and branch lifecycle

- `session_start`: invalidate prior ownership before initialization; restore persisted naming state and schedule eligible first naming in the background.
- `session_shutdown`: immediately invalidate/cancel scheduled and running work without awaiting provider completion. Covers quit, reload, new/resume/fork replacement in the installed runtime.
- `session_before_tree`: conservatively invalidate outstanding branch-bound work. This can cancel a title even when another extension cancels navigation; later normal triggers can retry.
- `session_tree`: advance branch generation after successful navigation and refresh branch-dependent counts. Keep session-wide manual-name protection and title ownership; a historical branch's saved auto title differing from the file-wide current name is not itself a new manual rename.
- Manual/external rename, including clearing a name: invalidate automatic ownership before applying/persisting manual state. Preserve the existing identical-name heuristic.
- Disabling automatic naming (or continuous mode for a continuous request) invalidates the affected automatic job. Result application also re-checks the relevant mode.

Use already-existing lifecycle events; do not introduce newer APIs such as `agent_before_settle`. Verify identity/lifecycle declarations against available types and the advertised minimum during implementation, or use a documented compatible fallback. Any required minimum-version change would need renewed approval.

## 4. Deadline and cancellation in `generateName`

Every request gets a 30-second deadline regardless of an upstream signal. Own a request-specific controller and forward explicit upstream cancellation to it without ever calling `ctx.abort()` or aborting the primary Agent controller.

For automatic work, pass the session-owned signal explicitly instead of inheriting `ctx.signal` from an unrelated primary run. Explicit `/rename` may continue to use its command/run cancellation source, combined with the independent deadline.

Race provider completion against local timeout/cancellation. Abort the provider on deadline/cancel, but settle the extension's local result even if the provider ignores the signal. Consume late provider rejection and ignore late success. Remove timer and signal listeners on every exit, including pre-aborted signals and provider/auth failure.

Lifecycle/manual supersession is silent and does not set the automatic failure cooldown. Real provider errors and timeouts retain existing user-facing error policy and first-naming cooldown. The return contract remains `{ name } | { error }`; add only internal cancellation metadata if required to distinguish intentional cancellation cleanly.

## 5. Explicit `/rename`

Keep the command's awaited interaction and manual persistence semantics. Starting a manual AI request supersedes automatic work so it cannot race the command. Apply its result only while its captured session/branch and name revision still belong to the command. A later manual rename/clear or lifecycle transition wins. Failure must not silently install a different title or permanently introduce new manual state beyond the existing contract.

## 6. Deterministic verification

### Offline harness

Extend the mock session manager with realistic session identity/branch transitions and track owner-specific side effects. Tests must directly prove handler completion while the title Promise is unresolved; `fireAsync()` alone is not evidence. Use microtask/event-loop checkpoints and explicit latches, not long sleeps or network requests.

Cover all three automatic trigger handlers, original single-flight/cooldown/continuous gates, normal Agent progression during naming, switch/reload/tree/shutdown races, manual command supersession, automatic-mode disable, stale success/failure/finally, independent deadline with/without upstream signals, providers that ignore abort, and late rejection consumption. Preserve custom API ID/registry assertions.

### Real CLI E2E

Use the installed CLI and the existing custom-API faux provider. Classify title versus main requests by prompt markers, not a shared response counter. Have the title request signal a started latch and remain unresolved. Main response requests a harmless helper tool; the tool proves the title is pending, then the next main model request proves it can also progress before releasing the title.

Record ordering markers into the test session and structurally parse JSONL. To prove eventual naming without print-exit races, the E2E main-response helper can wait for a session-info-changed latch after title release; this wait belongs only to the test provider, never product handlers. Add a never-finishing-title shutdown case that exits without naming.

Use a parent watchdog shorter than the product deadline, so the old blocking implementation fails promptly rather than appearing to pass after timeout. Record/terminate only the test's child PID, wait for it, and clean up in a trap. Run offline with isolated agent/work/session directories and `PI_OFFLINE=1`.

## 7. Compatibility, operational behavior, and rollback

- No new configuration or persistent state schema; old saved sessions remain readable.
- Title generation does not enter the primary conversation or change its model. Shared provider quotas/network contention remain outside the no-await guarantee.
- On short-lived print-mode runs, shutdown may cancel a pending title. Do not wait for the title merely to preserve prior E2E timing.
- A provider ignoring cancellation may retain its own resources; no application-level timeout can forcibly terminate arbitrary provider code. Local ownership, timer/listener cleanup, and stale-side-effect safety are mandatory.
- Preserve baseline WIP; validate the current installed CLI separately from bundled runtime-source evidence. Correct missing type paths only as needed and report versions actually checked.
- If verification fails, revert only task-owned edits relative to the existing WIP. Do not discard prior registry fixes or unrelated CodeGraph files.
