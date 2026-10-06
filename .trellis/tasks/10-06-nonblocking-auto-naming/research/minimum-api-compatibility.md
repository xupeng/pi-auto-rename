# Minimum Pi API compatibility

Verified against official upstream source at tag `v0.84.0` on 2026-10-06. This is source/API verification, not execution of an installed 0.84 runtime. Current runtime testing remains separately required on the installed CLI 1.0.2.

## Existing lifecycle APIs

Source: `https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/extensions/types.ts`

- Lines 615-652 define shutdown reasons for quit, reload, and session replacement, plus before/after tree navigation events.
- Lines 1212-1214 expose the corresponding event registrations on ExtensionAPI.

No newer event such as agent_before_settle is needed by the approved design.

## Session identity

Source: `https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/session-manager.ts`

Lines 190-206 expose session ID/file, leaf/entry lookup, and current branch through ReadonlySessionManager. The planned session ID plus local generation guard can use the advertised minimum API.

## Registry calls

Source: `https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/model-registry.ts`

Lines 103-108 expose registry completion with model, context, and optional stream options. The existing WIP registry migration therefore does not require raising the advertised minimum for this API.

## Remaining validation boundary

Typecheck against available current declarations, execute real CLI E2E, and avoid declaring complete 0.84 runtime coverage from these source checks alone. Check any additional API introduced during implementation against the same minimum. If a new requirement cannot be met on the advertised minimum, return for scope/compatibility approval rather than silently bumping it.
