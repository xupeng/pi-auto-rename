# Pi Extension API — Executable Contracts

The extension advertises pi >=0.84. Required registry, session identity, and
shutdown/tree APIs were checked in official v0.84.0 source. Current runtime
checks use standalone CLI 1.0.2 and readable pi-web runtime/types at 1.0.0;
these are distinct from full execution coverage of every supported release.

## Scenario: building an extension that calls AI, names sessions, persists state

### 1. Scope / Trigger

Any extension that: calls an LLM for a side task (naming, summarization),
mutates session metadata, or persists per-session state. Covers the contracts
verified while implementing pi-auto-rename.

### 2. Signatures

```ts
// AI call — MUST go through the session's model registry (pi's composed provider)
import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";

await ctx.modelRegistry.complete(
  model, // Model<Api> — resolved via ctx.model or ctx.modelRegistry.find(p, id)
  { systemPrompt: string, messages: UserMessage[] }, // UserMessage = { role:"user", content:[{type:"text",text}], timestamp }
  { maxTokens, signal } // ModelsApiStreamOptions — auth (apiKey/headers/baseUrl) is resolved by the registry
) // → Promise<AssistantMessage>; THROWS on auth/provider failure; check .stopReason ("error"|"aborted") + .content text blocks

// Auth inspection (not needed for calls — the registry resolves it for you)
ctx.modelRegistry.getApiKeyAndHeaders(model) // → { ok, apiKey, headers, error }

// Session naming
pi.setSessionName(name: string); pi.getSessionName(): string | undefined
pi.on("session_info_changed", (event) => void) // event.name = normalized name | undefined

// Per-session persistence (custom entries do NOT enter LLM context)
pi.appendEntry(customType: string, data: unknown)
// Restore: iterate sm.getBranch() in reverse, take last
// { type: "custom", customType, data } entry (with type guards)
```

### 3. Contracts

- AI calls go through `ctx.modelRegistry.complete()`. Never call `complete()`
  from `@earendil-works/pi-ai/compat`: compat dispatches on pi-ai's *global* api
  registry, which only holds builtin api ids, so a model whose api id is
  registered by a provider extension (`registerProvider({ api, streamSimple })`,
  e.g. cliproxyapi's `cliproxyapi-codex-responses`) fails with
  `No API provider registered for api: <id>`. The registry resolves auth and
  routes to the composed provider, so those models work too.
- Model resolution order: explicit override (config) → `ctx.model` (session
  model). `ctx.scopedModels` is the session-scoped model list for pickers
  (empty = all available via `ctx.modelRegistry.getAvailable()`).
- `session_start` reason: `"startup" | "new" | "resume" | "fork" | "reload"`.
- `session_info_changed` fires for BOTH user `/name` and extension
  `pi.setSessionName()`; the event carries no source — distinguish by comparing
  `event.name` with the name the extension last set (heuristic, edge case
  accepted: user manually re-setting the identical auto name).
- Extension command names collide across extensions → pi appends numeric
  suffixes (`/cmd:1`); `getArgumentCompletions(prefix)` returns
  `{ value, label }[] | null`.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| `resolveModel` fails / model not found | return `{ error }`; auto path → silent skip + warning notify (TUI only); manual command → error notify |
| Notification in a non-`tui` mode (`ctx.mode`, e.g. pi-web = `rpc`) | naming confirmations and automatic-path warnings are suppressed (`notifyInTerminal`); explicit command errors/config feedback still use `notify` |
| User message is an expanded `/skill:` block (`parseSkillBlock` matches) | naming input uses the typed args, or `/skill:<name>` when there are none — never the SKILL.md body |
| No API key / provider not configured | the registry throws `Provider is not configured: <provider>` → catch returns `{ error }` → same as above |
| `complete` stopReason `"error"` / `"aborted"` | return `{ error: errorMessage ?? stopReason }` |
| Empty / unusable model output | sanitize → `null` → `{ error: "empty title" }` |
| Config read failure / corrupt JSON | fall back to defaults, never throw |
| Config write failure | notify warning; in-memory config stays effective |
| Extension handler throws | wrap every handler in try/catch — a throw breaks the pi session |

### 5. Good / Base / Bad Cases

- Good: first-naming races with user manual rename → in-flight result is
  discarded (re-check `state.manual` AND current name after every `await`).
- Base: continuous naming thresholds (≥5 min since last auto name AND ≥3 new
  messages) prevent spamming the model.
- Bad: `applyAutoName` without a manual-state guard overwrites a name the user
  set while the AI request was in flight (reproduced: continuous path
  overwrote manual name + destroyed persisted manual state).

### 6. Tests Required

Offline harness (no network): faux provider registry + patched `Date.now` +
captured `setTimeout` + a mock `ctx.modelRegistry.complete()` (which mirrors the
runtime: auth first, then dispatch). `@earendil-works/pi-ai/compat` is shimmed to
throw, so a regression back to compat fails the suite. Assertion points:

- manual-name iron rule survives in-flight races (deferred complete resolved
  after user rename)
- failure cooldown (no retry within window; recovers after)
- the independent deadline releases the single-flight flag even with an
  upstream signal or a provider that ignores abort
- a model whose api id only exists in a provider extension (cliproxyapi-style)
  is named successfully through the registry, with no warning
- partial config preserves explicit values and defaults missing fields
- `readState` picks the LAST valid custom entry, skipping corrupt data

The offline harness mocks the registry, so the routing claim also has a
real-runtime E2E that boots the actual `pi` binary with a faux provider
extension (custom api id) and asserts the session gets an automatic name:

```bash
~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-registry -- \
  bash .harness/e2e-registry-naming.sh   # explicit PI_BIN supported; no provider network
```

### 7. Wrong vs Correct

#### Wrong

```ts
// Overwrites a manual name set while the AI request was in flight
const result = await generateName(ctx, config, kind, input);
if (result.name) applyAutoName(ctx, result.name); // no re-check after await
```

#### Correct

```ts
// Inside contained background work, after synchronously reserving request:
const result = await generateName(ctx, configSnapshot, kind, input, {
  signal: request.controller.signal,
});
if (!isCurrentRequest(request)) return; // owner + lifecycle + name revision
if (result.error || state.manual) return;
if (result.name) applyAutoName(ctx, result.name); // also check expected name/mode
```

## Gotchas

> **Warning**: never call `complete()` from `@earendil-works/pi-ai/compat` in an
> extension. compat resolves the api implementation from pi-ai's global api
> registry (builtin ids only), so models whose api id comes from a provider
> extension — `cliproxyapi-codex-responses` from
> `@router-for-me/pi-cliproxyapi-provider` was the real case — throw
> `No API provider registered for api: <id>` even though pi itself streams them
> fine. Use `ctx.modelRegistry.complete()`, which resolves auth and routes to the
> composed provider.

> **Warning**: never await long work without re-validating session state
> afterwards. Users can rename or mark the session manual while your request
> is in flight. Guard every auto-mutation: manual flag + name comparison.

> **Warning**: an upstream AbortSignal is not a deadline, and abort does not
> force a provider Promise to settle. Always impose an independent local
> deadline/cancellation race, consume late provider rejection, and remove all
> owned timers and listeners on every exit path.

## Scenario: nonblocking automatic titles and stale-result protection

### 1. Scope / Trigger

Use this contract for auxiliary AI work launched from `session_start`,
`message_end`, or `agent_settled`, and explicit `/rename` work that can outlive
its original session/branch/name ownership. The primary Agent must never wait
for automatic title generation.

### 2. Signatures

```ts
export declare function generateName(
  ctx: ExtensionContext,
  config: RenameConfig,
  kind: "first" | "history" | "update",
  input: string,
  options?: { currentName?: string; signal?: AbortSignal },
): Promise<{
  name?: string;
  error?: string;
  reason?: "timeout" | "cancelled";
}>;
```

`options.signal` explicitly replaces `ctx.signal`. Automatic callers pass an
extension-owned signal rather than the primary Agent run's signal. Every
request forwards cancellation into a request-specific controller and has a
30-second deadline independently of the upstream signal.

Ownership in `index.ts` uses an active request object, branch/session
generation, name epoch, and single-flight flag. `/rename` additionally checks
session identity. Lifecycle cancellation uses `session_shutdown`,
`session_before_tree`, and `session_tree`.

### 3. Contracts

- Reserve single-flight ownership synchronously before scheduling automatic
  work. Automatic handlers must neither await nor return the provider/request
  Promise. Deferred workers contain all errors, including metadata and UI
  failures; avoid unobserved detached rejection.
- `message_end` is awaited before SessionManager persists its event message.
  A microtask is not a persistence barrier. Current naming intentionally uses
  the already-persisted branch rather than treating the current event as final.
- Validate active owner, generation, and name epoch before success, failure
  notification, cooldown update, or any other session side effect. Only the
  object that still owns the single-flight guard may release it in `finally`.
- Normal message/custom-entry appends advance the leaf and must not invalidate
  valid title work. Do not require the leaf ID to equal its initial value.
- Tree navigation changes the branch without rebuilding the session runtime.
  Invalidate before navigation and advance generation after success. Preserve
  session-wide manual/title ownership; a historical branch's naming state
  differing from the current file-wide title is not a new manual rename.
- Shutdown/reload/session replacement invalidate pending work immediately,
  without awaiting provider completion. Validate ownership before accessing an
  old context whose getters may throw after runtime invalidation.
- Manual rename/clear invalidates outstanding work and advances name epoch.
  This detects clear-while-empty and ABA changes that plain name equality
  misses. The existing identical-last-name source heuristic remains accepted.
- Explicit AI `/rename` owns the guard while awaited, suspending automatic
  scheduling. Newer manual work supersedes it; failure/cancellation releases
  the guard without permanently adding manual state. Success persists manual
  state. Disabling automatic configuration must not cancel explicit commands.
- Race provider completion with local cancellation/deadline; consume late
  provider rejection and drop late success. Remove the deadline, upstream
  abort listener, and local abort listener in every cleanup path.
- Never call `ctx.abort()` or abort the primary Agent's controller for title
  cleanup. A noncooperative provider can continue its own work, but cannot keep
  local ownership or perform stale side effects through the extension.
- Print/json shutdown may cancel an unfinished title; do not keep the Agent or
  process waiting only to obtain naming metadata.

### 4. Validation & Error Matrix

| Condition | Outcome |
|---|---|
| Valid completed request | Sanitized title applied only by current owner |
| Lifecycle/manual supersession | Silent local cancellation; no failure cooldown or stale notification |
| 30-second deadline, including ignored abort | `{ error, reason: "timeout" }`; current automatic owner follows existing failure policy |
| Upstream already aborted | `{ error, reason: "cancelled" }`; no provider dispatch |
| Late provider resolve/reject | No session mutation or unhandled rejection |
| Old request finalizer after a new request starts | Must not clear the new guard |
| Mode disabled | Cancel affected automatic request, retain explicit `/rename` |
| Ordinary Agent message append | Existing valid request remains eligible to apply |
| Manual AI request fails | Report current command error and restore scheduling eligibility |

### 5. Good / Base / Bad Cases

- Good: title remains unresolved while a real Agent executes a tool and issues
  its next model request; title applies later if its owner remains valid.
- Base: continuous naming retains its time/message gates and KEEP behavior;
  only one naming request owns the current guard.
- Bad: `void` starts detached work but a late `finally` clears a newer request,
  a stale error writes cooldown into another session, or clear-while-empty is
  missed because the name remained `undefined`.

### 6. Tests Required

- Directly assert automatic handlers settle while the provider Promise remains
  unresolved; merely calling the handler without awaiting it proves nothing.
- Cover lifecycle/branch/mode-disable/manual cancellation, late success/error,
  old-owner/new-owner cleanup, clear/ABA, and explicit command failure recovery.
- Exercise deadline with/without an upstream signal, noncooperative providers,
  pre-aborted input, primary-signal independence, and listener cleanup.
- In real-runtime E2E hold the title until tool execution and the next main
  model request occur. Use latches and a watchdog shorter than the product
  deadline; a never-finishing-title case must settle and exit without state.
- Parse session JSONL structurally. Classify requests at the provider boundary
  using normalized transcript system messages (via `getSystemMessageText`), not
  a nonexistent provider `context.systemPrompt` or shared response sequence.
- Use isolated HOME/agent/work/session directories under verified TMPDIR and
  clean owned processes/sandboxes. Preserve formal evidence outside auto-cleaned
  cache when needed for delivery.

### 7. Wrong vs Correct

#### Wrong

```ts
pi.on("message_end", async (_event, ctx) => {
  await attemptFirstNaming(ctx); // awaited provider latency blocks Agent flow
});
// Or: every old request unconditionally clears state.inFlight in finally.
```

#### Correct

```ts
pi.on("message_end", (_event, ctx) => {
  scheduleFirstNaming(ctx); // reserve synchronously; return no request Promise
});
// Inside contained worker:
try {
  const result = await generateName(ctx, snapshot, "first", input, {
    signal: request.controller.signal,
  });
  if (!isCurrentRequest(request)) return;
  // Apply only after result/manual/name/mode checks.
} finally {
  if (ownsGuard(request)) {
    activeRequest = null;
    state.inFlight = false;
  }
}
```

## Anti-patterns

### Don't: fire-and-forget retries on every event

**Problem**: a permanent failure (missing key) retriggers on every
`message_end`, spamming warnings (3+ per turn reproduced).

**Instead**: failure cooldown — record `lastFailTime`, skip retries for a
window (5 min), reset on `session_start`.

### Don't: use `pi.appendEntry` for config shared across sessions

Session custom entries are per-session; global config belongs in a file under
the agent dir. Use appendEntry only for per-session state that must survive
restart/resume.

### Don't: put extension config files inside `~/.pi/agent/extensions/`

**Problem**: the `extensions/` directory is for extension *code*; pi itself and
the ecosystem extensions (pi-image, pi-web-search, ...) keep their config at
`<agentDir>/<ext-name>.json` — same level as `auth.json` / `models.json` /
`settings.json`. Storing config under `extensions/` (as the
pi-session-auto-rename reference did) is a minority convention.

**Instead**: resolve via the official helper, so rebranded installs
(`PI_AGENT_DIR`, non-`.pi` config dirs) keep working:

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const configPath = join(getAgentDir(), "pi-auto-rename.json"); // ~/.pi/agent/...
```

For a first-version extension, skip legacy-path/legacy-shape migration
entirely: read only the canonical file and fall back to defaults.
