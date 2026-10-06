# Non-blocking automatic session naming

## Goal

Automatic session title generation must not put model-request latency on the Agent's execution path. The Agent must continue replying, executing tools, and settling while title generation is pending.

## Background

- The user explicitly requires automatic title generation not to block or slow the active Agent's execution rhythm.
- `index.ts:322`, `index.ts:345`, and `index.ts:353` await naming from session initialization, message completion, and Agent settlement respectively.
- `naming.ts:150-159` installs its 30-second cancellation timer only when no external signal exists. A provider that ignores cancellation can keep the request pending indefinitely.
- Existing uncommitted changes migrate naming to `ctx.modelRegistry.complete()` and add provider-extension regression coverage. Preserve those changes; do not revert to the compat API.

## Requirements

- R1: Automatic first naming and continuous renaming must not make session or Agent event handlers wait for a title request.
- R2: Background results must never rename or write naming state into a different session/branch, overwrite a manual name, or clear a newer request's bookkeeping.
- R3: Naming must have an independent 30-second deadline, release local request ownership on timeout/cancellation even if the provider ignores abort, and contain late rejections.
- R4: Keep current model selection, prompts, configuration defaults, manual-name protection, automatic single-flight behavior, retry cooldown, continuous thresholds, and registry-based provider compatibility.
- R5: Cancel/invalidate automatic work when its session/branch is replaced or shuts down, manual naming supersedes it, or its automatic mode is disabled; cancellation of a title request must never abort the primary Agent. Lifecycle/manual cancellation must not generate stale warnings or failure cooldowns.
- R6: Add deterministic unresolved-request tests and real-runtime evidence that main Agent work progresses before the title is available.

## Acceptance Criteria

- [x] AC1 (R1): With a never-resolving title request, automatic session initialization, `message_end`, and `agent_settled` handlers finish without waiting for title completion.
- [x] AC2 (R1, R6): Real Pi executes a later tool/model step while a custom-provider title request is pending.
- [x] AC3 (R2, R5): A late result or rejection after a session/branch transition, manual rename, automatic-mode disable, or shutdown cannot change the name, persist stale state, emit stale notifications, update failure cooldown, or release a newer request. Normal message appends do not invalidate a valid title request.
- [x] AC4 (R3): Requests settle locally at the deadline with and without an external signal, including when the provider ignores abort; timers/listeners are cleaned up and late results/rejections are contained.
- [x] AC5 (R4): Existing regression coverage for manual names, first-name retry cooldown, continuous-renaming gates, registry calls, and extension-registered API IDs remains green.
- [x] AC6 (R4, R5): Explicit `/rename` behavior remains usable, supersedes pending automatic work, and cannot apply a result after its session/branch or name ownership changes.

## Out of Scope

- Guaranteeing zero effect from shared provider quotas, network contention, or JavaScript execution overhead.
- Changing title style, language, configuration schema, or automatic-renaming thresholds.
- Adding a worker process, external queue, provider scheduler, or automatic model switch.
- Turning explicit `/rename` into a background command; it continues to await its requested result.
- Keeping print-mode Pi alive just to obtain a title after the main task is complete. Shutdown may cancel an unfinished title.
- Committing, pushing, archiving, or updating Trellis itself during planning.

## Constraints and Risks

- Preserve the existing registry-based naming WIP and untracked E2E fixtures; do not stage, commit, or discard unrelated changes.
- Automatic requests use session-owned cancellation rather than the primary Agent run's signal. There is no new persistent configuration or package dependency.
- A provider that ignores abort may continue its own work after the extension abandons the result. The contract is bounded local ownership and no stale side effects, not forced termination of arbitrary provider code.
- Runtime source/types were checked at pi-web's bundled Pi 1.0.0; actual CLI tests use 1.0.2. Missing 0.85.1 typecheck paths were replaced with readable local declarations. Required lifecycle/session identity/registry APIs were also verified in official v0.84.0 source; the advertised minimum is unchanged, but no installed 0.84 runtime was executed.

## Artifact Status

The user explicitly approved the final planning summary before implementation. Product code, documentation, and regression tests are implemented; independent review found no remaining blockers after local test reliability/cleanup fixes. Acceptance evidence is in `validation/acceptance.md`. The user subsequently authorized the three-part commit plan, task archive, session journal, and a draft PR. Delivery targets `github.com/xupeng/pi-auto-rename`, from `fix/nonblocking-auto-naming` to `main`; CodeGraph data is excluded.
