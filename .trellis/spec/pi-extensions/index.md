# Pi Extensions Development Guidelines

> Best practices for building pi coding-agent extensions in this repository.

## Overview

This repository hosts pi extensions (TypeScript modules loaded via jiti, no
build step). Guidelines cover the extension API contracts used by
pi-auto-rename, including minimum-version source checks and current-runtime
verification. State the versions actually checked rather than assuming the
latest installed runtime proves every supported version.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Extension API](./extension-api.md) | API contracts, background naming ownership/deadlines, events/state patterns | Active |

## Key Facts

- Extension AI calls use `ctx.modelRegistry.complete()` (pi 0.84+); the
  `@earendil-works/pi-ai/compat` `complete()` only knows builtin api ids and
  breaks provider-extension models — see extension-api.md.
- Automatic naming handlers must not await model latency. Reserve a request
  synchronously, dispatch it in contained background work, and validate owner,
  lifecycle generation, and name revision before every side effect.
- Every title request has an independent 30-second local deadline, including
  requests with an upstream signal. Abort alone is not sufficient when a
  provider ignores cancellation.
- Runtime verification uses standalone CLI 1.0.2; readable runtime/types are
  pi-web's Pi 1.0.0. Required lifecycle/session identity/registry APIs were
  additionally checked in official source at tag v0.84.0, not by executing a
  locally installed 0.84 runtime.
- Extensions in `~/.pi/agent/extensions/` (or `* /index.ts`) hot-reload via
  `/reload`; project-local equivalents live in `.pi/extensions/`.

## Quality Check

- Run the offline harness with an isolated temporary HOME; it writes naming
  configuration and must never use the user's real agent directory.
- Typecheck against available runtime declarations and report their version.
- Run both custom-provider E2Es via `pi-tmp-run`: registry routing and held-title
  Agent progression. Use an explicit CLI binary and offline test provider.
- Verify stale success/error/finally, manual clear/ABA, branch transitions,
  abort-ignoring providers, listener/timer cleanup, and nonblocking shutdown.
- Update executable contracts when lifecycle or request ownership changes.
