## Intent

Keep automatic session title generation off the Agent's execution path, so slow or hung title requests cannot delay replies, tools, or settlement. Preserve custom-provider compatibility and manual-name protection.

## Changes

- Route title requests through the model registry instead of the compat API so extension-registered API IDs use Pi's composed provider and authentication.
- Reserve naming ownership synchronously and dispatch automatic first naming and continuous updates as contained background work.
- Give every request an independent 30-second local deadline, consume late provider failures, and clean up cancellation listeners even when the provider ignores abort.
- Guard results, notifications, cooldowns, and finalizers with request identity, lifecycle generation, and name revision; invalidate work on session or branch changes, shutdown, manual renames, and automatic-mode disable.
- Keep explicit `/rename` awaited, suspend automatic naming while it runs, and protect clears, same-name ABA changes, and newer manual requests from stale results.
- Add deterministic offline and custom-provider E2E coverage that holds titles pending while tools and subsequent main requests progress, including nonblocking shutdown and bounded watchdog cleanup.
- Document the executable runtime contracts and include task acceptance, archive, and session journal records with the implementation.
