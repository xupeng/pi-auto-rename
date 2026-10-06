# Runtime lifecycle evidence

Investigation date: 2026-10-06. Read-only research; no tests, services, or temporary workspaces were created.

## Source roots and versions

- WEB: `/home/xupeng/services/pi-web/dist/node_modules/@earendil-works`.
- CLI: `/home/xupeng/.local/share/mise/installs/pi/1.0.2/pi`.
- Readable runtime source was verified in WEB's `pi-coding-agent` 1.0.0, plus neighboring `pi-agent-core` and `pi-ai`.
- Actual installed CLI metadata identifies 1.0.2 (`CLI/package.json:3`). CLI docs describe the same context invalidation/lifecycle contract; the standalone CLI installation has no readable `dist/core` JS. This is not a CLI runtime execution result.
- `.harness/tsconfig.check.json:13-23` references 0.85.1 pnpm global packages that are currently absent. No 0.84/0.85 source/declaration validation was completed. Do not present source observations at 1.0.0 as a check of every pi >=0.84 release.

## Awaited event path and message persistence

| Source under WEB | Evidence |
|---|---|
| `pi-agent-core/dist/agent.js:395-435` | Agent state is updated, then listeners are individually awaited. |
| `pi-agent-core/dist/agent-loop.js:43-56` | Initial message lifecycle events finish before the model loop starts. |
| `pi-agent-core/dist/agent-loop.js:150-174,306-320` | Assistant `message_end` is awaited before tool execution. |
| `pi-coding-agent/dist/core/extensions/runner.js:807-829,858-888` | Ordinary and message-end handlers are individually awaited. |
| `pi-coding-agent/dist/core/agent-session.js:734-754` | Extension dispatch precedes public listeners and SessionManager message persistence. |
| `pi-coding-agent/dist/core/agent-session.js:671-695` | Settled extension dispatch precedes public notification, deferred actions, and idle waiter release. |

Consequences: naming latency currently delays Agent progress. The current event message is not yet in `ctx.sessionManager.getBranch()` during `message_end`; Agent state already contains it, but extensions have no corresponding public state access. A microtask is not a persistence barrier because later extension handlers are also awaited. Preserve current material selection unless an explicit separate change is justified.

## Lifecycle boundaries and identity

- New/resume: before-switch, abort outgoing Agent, shutdown, invalidate/dispose old runtime, new runtime's session_start.
- Fork: before-fork, teardown, new runtime's session_start.
- Reload: shutdown, invalidate old runner, build new runtime, session_start.
- Quit: shutdown then disposal.
- Tree navigation: before-tree, switch leaf, session_tree on the same runtime/session; no session_start or teardown.

Sources: `pi-coding-agent/dist/core/agent-session-runtime.js:79-128,130-249,302-310`; `pi-coding-agent/dist/core/agent-session.js:2899-2931,3162-3321`; event declarations in `core/extensions/types.d.ts:546-643`.

`ReadonlySessionManager` declares `getSessionId`, `getSessionFile`, `getLeafId`, `getBranch`, and `getEntry` at `core/session-manager.d.ts:178`. Implementations: `session-manager.js:779-784,1002-1010,1062-1073`. Ordinary appends advance the leaf (`:819-824`), so strict leaf equality would reject healthy results while the Agent progresses.

Use session ID plus local lifecycle/branch generation and request token. Session ID alone does not distinguish reload or same-session tree navigation. Validate error/cooldown/notification/finally as well as successful name application. Old finalizers in `index.ts:243-244,279-280` must not clear new ownership.

Session name is file-wide latest session_info (`session-manager.js:928-939`), while custom naming state restoration reads the current branch. Do not misclassify a tree navigation as a new manual rename solely because historical branch state differs from the file-wide title.

## Context invalidation and cancellation

`extensions/runner.js:482-491,607-680` invalidates contexts, and context getters/mutators can throw after replacement. Capture necessary data before replacement and check local freshness before reading an old context or mutating session metadata.

The current `ctx.signal` comes from `agent.signal` (`agent-session.js:2720`, `runner.js:656-659`). A controller is created per run; normal completion clears activeRun rather than aborting that captured signal (`pi-agent-core/dist/agent.js:344-364,382-387`). Therefore do not claim ordinary Agent completion automatically aborts title generation. Session-owned automatic cancellation avoids coupling to an unrelated run.

`naming.ts:150-159` lacks an independent deadline when an upstream signal exists and relies on provider cooperation when aborting. Race provider completion against local deadline/cancellation, consume late rejection, and detach listeners/timers. Runtime completion at `pi-coding-agent/dist/core/model-runtime.js:446-487` resolves auth/provider then awaits stream.result; abort does not force arbitrary provider completion.

Avoid introducing `agent_before_settle`: the bundled changelog records it only at 0.87 (`CHANGELOG.md:218-230`). Earlier awaited lifecycle history at 0.75.4 (`:1776`) is supporting history, not a substitute for minimum-version declaration verification.

## Deterministic custom-provider E2E design

1. Distinguish primary and naming requests using the naming system-prompt marker.
2. Main model emits a harmless test tool call; naming signals a started latch and waits indefinitely.
3. Tool waits for naming-started, asserts title pending/absent, and records progress.
4. Next primary model request asserts title still pending and sees the tool result, records progress, then releases title.
5. Test-only model helper waits for the expected session-info-changed title latch before finishing, avoiding print-mode exit races. Parse session JSONL structurally to check progress before naming-state writes.
6. A second scenario never releases title and proves tool/main progress plus Agent settlement and shutdown occur without title writes.

Old awaited naming cannot reach the tool; use a parent watchdog shorter than 30 seconds to fail it. The existing fast-title routing E2E alone proves registry routing, not nonblocking behavior. Print mode disposes after prompt completion (`pi-coding-agent/dist/modes/print-mode.js:103-139`), so do not rely on detached title work randomly finishing before process exit.

Run actual CLI 1.0.2, isolate configuration/sessions/work, set `PI_OFFLINE=1`, use verified `TMPDIR`/pi-tmp-run, and record/terminate only the child PID. The existing shell fallback `${TMPDIR:-/tmp}` should not be used in task verification. No temporary artifacts or processes were created during this research.
