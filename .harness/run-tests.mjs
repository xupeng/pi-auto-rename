/**
 * Offline verification harness for pi-auto-rename.
 *
 * - Faux provider registry + controllable API-key policy (no real network).
 * - Controllable clock (Date.now patched) and fake timers (setTimeout captured)
 *   so the 5-min thresholds and the 30s naming timeout are fully deterministic.
 * - Mock `ctx.modelRegistry.complete` in the mock ctx (the naming call's only
 *   entry point: it mirrors the runtime — resolve auth, then dispatch). The
 *   @earendil-works/pi-ai/compat shim now throws, so any fallback to compat
 *   fails the suite instead of silently passing.
 *
 * Setup (once): bash .harness/setup.sh  (creates node_modules shims)
 * Run inside an isolated temp home, never the real HOME:
 *   ~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-offline -- \
 *     bash -c 'export HOME="$(mktemp -d "$PI_TASK_TMPDIR/home.XXXXXX")"; node .harness/run-tests.mjs'
 * Real-runtime E2E (needs `pi` on PATH, or set PI_BIN):
 *   ~/.pi/agent/bin/pi-tmp-run --keep-on-failure auto-rename-registry -- \
 *     bash .harness/e2e-registry-naming.sh
 * Typecheck: cd .harness && npx --yes -p typescript@5.9.2 tsc -p tsconfig.check.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setImmediate as _setImmediate } from "node:timers";
import { getEventListeners } from "node:events";

// ---------------- global failure containment ----------------
// A late provider rejection after cancellation must be consumed by the request
// owner. Any unhandled rejection fails the suite instead of surfacing later.
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

// ---------------- controllable clock ----------------
const clock = { now: 1_700_000_000_000 };
Date.now = () => clock.now;

// ---------------- fake timers (capture; never really fire) ----------------
let timerQueue = [];
let timerHandle = 1;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  const handle = { id: timerHandle++ };
  timerQueue.push({ fn, delay, args, handle });
  return handle;
};
globalThis.clearTimeout = (handle) => {
  timerQueue = timerQueue.filter((t) => t.handle !== handle);
};
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
function resetTimers() {
  timerQueue = [];
  timerHandle = 1;
}
function fireAllTimers() {
  for (const t of timerQueue.splice(0)) t.fn(...t.args);
}
function pendingTimerCount() {
  return timerQueue.length;
}

// ---------------- complete() controller (used by the mock model registry) ----------------
globalThis.__ARN__ = { completeCalls: [], compatCalls: [] };

function setComplete(behavior) {
  globalThis.__ARN__.complete = behavior;
}
function okComplete(text, stopReason = "stop") {
  return async () => ({
    stopReason,
    content: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}
/** A complete() that hangs until the harness resolves/rejects it (or aborts). */
function deferredComplete() {
  const d = { resolve: null, reject: null, promise: null, aborted: false };
  d.promise = new Promise((res, rej) => {
    d.resolve = res;
    d.reject = rej;
  });
  const fn = (_model, _context, options) => {
    options?.signal?.addEventListener("abort", () => {
      d.aborted = true;
      d.reject(new DOMException("The operation was aborted.", "AbortError"));
    });
    return d.promise;
  };
  return { fn, d };
}

/**
 * A complete() that never settles and ignores the abort signal entirely.
 * Models a provider that does not cooperate with cancellation.
 */
function abortResistantComplete() {
  const d = { resolve: null, promise: null };
  d.promise = new Promise((res) => {
    d.resolve = res;
  });
  const fn = () => d.promise;
  return { fn, d };
}

/** A complete() that never settles and never rejects. */
function neverComplete() {
  return () => new Promise(() => {});
}

// ---------------- faux provider registry ----------------
const MODELS = {
  faux: {
    "model-a": { provider: "faux", id: "model-a", label: "Faux A" },
    "model-b": { provider: "faux", id: "model-b", label: "Faux B" },
  },
  nokey: {
    "model-b": { provider: "nokey", id: "model-b", label: "NoKey B" },
  },
  // Reproduces the real cliproxyapi case: the api id is registered by a provider
  // extension, so it exists only in pi's composed provider — never in the global
  // api registry that @earendil-works/pi-ai/compat dispatches on.
  cliproxy: {
    "codex-model": {
      provider: "cliproxy",
      id: "codex-model",
      api: "cliproxyapi-codex-responses",
    },
  },
};
let KEY_POLICY = {
  faux: { ok: true, apiKey: "test-key", headers: { "X-Test": "1" } },
  nokey: { ok: false, error: "no api key configured" },
  cliproxy: { ok: true, apiKey: "cpa-key", headers: {} },
};
function resetKeyPolicy() {
  KEY_POLICY = {
    faux: { ok: true, apiKey: "test-key", headers: { "X-Test": "1" } },
    nokey: { ok: false, error: "no api key configured" },
    cliproxy: { ok: true, apiKey: "cpa-key", headers: {} },
  };
}

// ---------------- mock pi / ctx ----------------
function makePi(opts = {}) {
  const handlers = new Map();
  const pi = {
    _opts: opts,
    entries: [],
    name: undefined,
    notifications: [],
    commands: new Map(),
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, def) {
      this.commands.set(name, def);
    },
    getSessionName() {
      return this.name;
    },
    setSessionName(name) {
      this.name = name ?? undefined;
      // pi fires session_info_changed whenever the display name is set.
      const h = handlers.get("session_info_changed");
      if (h) void h({ name: this.name }, makeCtx(this));
    },
    appendEntry(customType, data) {
      this.entries.push({
        type: "custom",
        customType,
        data,
        id: `e${this.entries.length}`,
        parentId: null,
        timestamp: new Date(clock.now).toISOString(),
      });
    },
  };
  return pi;
}

function makeCtx(pi) {
  const opts = pi._opts;
  return {
    model: opts.sessionModel ?? MODELS.faux["model-a"],
    scopedModels: opts.scopedModels ?? [],
    // pi-web binds extensions with mode "rpc" and forwards notify() to the page.
    mode: opts.mode ?? "tui",
    hasUI: opts.hasUI ?? true,
    signal: opts.signal, // undefined -> naming.ts own AbortController fallback
    modelRegistry: {
      find: (provider, id) => MODELS[provider]?.[id] ?? null,
      getAvailable: () => Object.values(MODELS).flatMap((m) => Object.values(m)),
      getApiKeyAndHeaders: async (model) =>
        KEY_POLICY[model.provider] ?? { ok: true, apiKey: "default-key", headers: {} },
      // Stands in for ModelRegistry.complete -> ModelRuntime.prepareRequest:
      // auth is resolved first (throwing like the runtime when unconfigured),
      // then the call is recorded and dispatched to the harness behavior.
      complete: async (model, context, options) => {
        const policy = KEY_POLICY[model.provider] ?? { ok: true, apiKey: "default-key", headers: {} };
        if (!policy.ok) throw new Error(`Provider is not configured: ${model.provider}`);
        globalThis.__ARN__.completeCalls.push({ model, context, options });
        return globalThis.__ARN__.complete(model, context, options);
      },
    },
    ui: {
      notify: (message, level) => pi.notifications.push({ message, level }),
      select: async () => opts.selectResult ?? null,
    },
    sessionManager: {
      getBranch: () => pi.entries,
      getSessionId: () => opts.sessionId ?? "sess-1",
      getLeafId: () => (pi.entries.length ? pi.entries[pi.entries.length - 1].id : null),
    },
  };
}

async function fire(pi, event, eventData = {}) {
  const h = pi.handlers.get(event);
  if (h) await h(eventData, makeCtx(pi));
}

/** Fire without awaiting completion (needed when the handler blocks on a deferred complete). */
function fireAsync(pi, event, eventData = {}) {
  const h = pi.handlers.get(event);
  if (!h) return Promise.resolve();
  return h(eventData, makeCtx(pi));
}

async function cmd(pi, name, args) {
  const def = pi.commands.get(name);
  if (!def) throw new Error(`command not registered: ${name}`);
  await def.handler(args, makeCtx(pi));
}

/** Start a command without awaiting its handler (for in-flight command races). */
function cmdAsync(pi, name, args) {
  const def = pi.commands.get(name);
  if (!def) throw new Error(`command not registered: ${name}`);
  return def.handler(args, makeCtx(pi));
}

function pushMessages(pi, texts) {
  for (const t of texts) {
    const text = typeof t === "string" ? t : t.text;
    pi.entries.push({
      type: "message",
      id: `m${pi.entries.length}`,
      parentId: null,
      timestamp: new Date(clock.now).toISOString(),
      message: {
        id: `msg${pi.entries.length}`,
        role: (typeof t === "string" ? "user" : t.role) ?? "user",
        content: text,
        timestamp: new Date(clock.now).toISOString(),
      },
    });
  }
}

function pushAssistant(pi, text) {
  pushMessages(pi, [{ role: "assistant", text }]);
}

// ---------------- config file helpers (HOME-scoped) ----------------
function configPath() {
  return join(homedir(), ".pi", "agent", "pi-auto-rename.json");
}
function writeConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}
function readConfigFile() {
  return existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), "utf8")) : null;
}

// ---------------- assertion + reporting ----------------
let failures = 0;
let passes = 0;
function assert(cond, label) {
  if (cond) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) {
    passes++;
    console.log(`  PASS  ${label} (= ${JSON.stringify(expected)})`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

async function runTest(name, fn) {
  resetTimers();
  globalThis.__ARN__.completeCalls = [];
  globalThis.__ARN__.compatCalls = [];
  clock.now = 1_700_000_000_000;
  resetKeyPolicy();
  writeConfig({ autoRename: true, continuousRename: false, style: "concise", language: "auto" });
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    await tick();
    assertEq(pendingTimerCount(), 0, `${name}: no request timer leaked`);
  } catch (e) {
    failures++;
    console.error(`  ERROR ${name}:`, e);
  }
}

const tick = () => new Promise((r) => _setImmediate(r));
const FIVE_MIN = 5 * 60 * 1000;

// =====================================================================
// T1a — Major 1: continuous in-flight, user /name during flight
// =====================================================================
async function t1a() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  // first naming
  setComplete(okComplete("Initial Title"));
  pushMessages(pi, ["hello there", "I need help with SQL", "here is the schema"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.name, "Initial Title", "T1a first naming applied");
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T1a exactly 1 complete call so far");

  // continuous evaluation in flight
  const hang = deferredComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["let's talk about indexing", "add a composite index", "and a covering index"]);
  pushAssistant(pi, "Sure, here is the plan");
  clock.now += 6 * 60 * 1000;
  const settled = fireAsync(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T1a continuous eval started (2nd complete call)");

  // user renames manually while the naming request is in flight
  pi.setSessionName("Manual Name");
  await tick();
  assertEq(pi.name, "Manual Name", "T1a user manual name applied");

  // now the in-flight naming resolves with a new auto title
  hang.d.resolve({
    stopReason: "stop",
    content: [{ type: "text", text: "New Auto Title" }],
    usage: {},
  });
  await settled;
  await tick();
  await tick();

  assertEq(pi.name, "Manual Name", "T1a auto result DROPPED — name not overwritten");
  const renamedNotifs = pi.notifications.filter((n) => n.message.includes("renamed"));
  assertEq(renamedNotifs.length, 0, "T1a no 'renamed' notify for the dropped auto title");

  // manual state persisted
  const stateEntries = pi.entries.filter((e) => e.type === "custom" && e.customType === "pi-auto-rename:state");
  const latest = stateEntries[stateEntries.length - 1];
  assertEq(latest?.data?.source, "manual", "T1a persisted state source is manual");
  assertEq(latest?.data?.name, "Manual Name", "T1a persisted state name is the manual name");

  // manual iron rule holds afterwards: further settled events do not rename
  pushMessages(pi, ["different topic now", "another message", "and one more"]);
  clock.now += 6 * 60 * 1000;
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T1a no further naming after manual (iron rule)");
  assertEq(pi.name, "Manual Name", "T1a name still manual");
}

// =====================================================================
// T1b — Major 1: continuous in-flight, silent external rename (name re-check)
// =====================================================================
async function t1b() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  setComplete(okComplete("Title A"));
  pushMessages(pi, ["m1", "m2", "m3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.name, "Title A", "T1b first naming applied");

  const hang = deferredComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["n1", "n2", "n3", "n4"]);
  clock.now += 6 * 60 * 1000;
  const settled = fireAsync(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T1b continuous eval in flight");

  // rename WITHOUT firing session_info_changed (state.manual stays false)
  pi.name = "Direct Name";
  hang.d.resolve({
    stopReason: "stop",
    content: [{ type: "text", text: "Auto B" }],
    usage: {},
  });
  await settled;
  await tick();
  await tick();

  assertEq(pi.name, "Direct Name", "T1b getSessionName re-check dropped the stale auto result");
  const renamedNotifs = pi.notifications.filter((n) => n.message.includes("renamed"));
  assertEq(renamedNotifs.length, 0, "T1b no 'renamed' notify");
}


// =====================================================================
// T1c — Major 1: first-naming in flight, user CLEARS the name (/name no args)
//       getSessionName() is falsy after the clear -> only the
//       applyAutoName `if (state.manual) return` insurance catches it.
// =====================================================================
async function t1c() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = deferredComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["g1", "g2", "g3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T1c first naming in flight");

  // user clears the name (built-in /name with no argument)
  pi.setSessionName(undefined);
  await tick();
  assertEq(pi.name, undefined, "T1c name cleared by user");
  assertEq(pi.notifications.some((n) => n.level === "warning"), false, "T1c no warning from clear itself");

  // in-flight naming resolves -> applyAutoName insurance must drop it
  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Auto After Clear" }], usage: {} });
  await pending;
  await tick();
  assertEq(pi.name, undefined, "T1c applyAutoName insurance: auto name dropped (manual never auto-covered)");
  const stateEntries = pi.entries.filter((e) => e.type === "custom" && e.customType === "pi-auto-rename:state");
  assertEq(stateEntries[stateEntries.length - 1]?.data?.source, "manual", "T1c manual state persisted after clear");
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T1c no further naming attempts");
}

// =====================================================================
// T2 — Minor 2: first-naming failure -> 5min circuit breaker, 1 warning
// =====================================================================
async function t2() {
  const pi = makePi({ sessionModel: MODELS.nokey["model-b"] }); // no API key
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  // First failure: the registry fails auth before any request is dispatched
  pushMessages(pi, ["q1", "q2", "q3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T2 failure happened before the request (auth stage)");
  let warnings = pi.notifications.filter((n) => n.level === "warning");
  assertEq(warnings.length, 1, "T2 exactly 1 warning after first failure");
  assert(warnings[0]?.message.includes("Auto rename skipped"), "T2 warning is 'Auto rename skipped'");
  assert(
    warnings[0]?.message.includes("Provider is not configured: nokey"),
    "T2 warning carries the registry's auth error",
  );

  // Same-turn second message_end must NOT retry (breaker active)
  pushMessages(pi, ["q4", "q5"]);
  await fire(pi, "message_end");
  await tick();
  warnings = pi.notifications.filter((n) => n.level === "warning");
  assertEq(warnings.length, 1, "T2 second message_end: still exactly 1 warning (no repeat)");
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T2 no retry while breaker active");

  // After 5 minutes the breaker expires and naming is attempted again
  clock.now += 5 * 60 * 1000 + 1000;
  KEY_POLICY.nokey = { ok: true, apiKey: "now-key", headers: {} }; // key becomes available
  setComplete(okComplete("Recovered Title"));
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T2 retried after 5min breaker expiry");
  assertEq(pi.name, "Recovered Title", "T2 session named after recovery");
}

// =====================================================================
// T3 — Minor 3: hanging complete -> 30s timeout aborts, inFlight released
// =====================================================================
async function t3() {
  const { NAMING_TIMEOUT_MS } = await import("../naming.ts");
  assertEq(NAMING_TIMEOUT_MS, 30_000, "T3 NAMING_TIMEOUT_MS is 30s");

  const pi = makePi({ signal: undefined }); // no external signal -> own controller
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = deferredComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["h1", "h2", "h3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();

  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T3 naming call in flight");
  const call = globalThis.__ARN__.completeCalls[0];
  assert(!!call.options?.signal, "T3 complete received an AbortSignal (own controller)");
  assertEq(pendingTimerCount(), 1, "T3 exactly 1 pending timer (30s timeout)");

  // 30s elapses -> captured timer fires -> abort -> promise rejects
  clock.now += 30_000;
  fireAllTimers();
  await tick();
  await tick();
  await pending;

  assertEq(hang.d.aborted, true, "T3 timeout aborted the request");
  let warnings = pi.notifications.filter((n) => n.level === "warning");
  assertEq(warnings.length, 1, "T3 exactly 1 warning after timeout abort");
  assertEq(pendingTimerCount(), 0, "T3 timer cleaned up (clearTimeout in finally)");

  // inFlight released + breaker: advance 5min, retry succeeds
  clock.now += 5 * 60 * 1000 + 1000;
  setComplete(okComplete("Timed Out Title"));
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T3 second call happened -> inFlight was released");
  assertEq(pi.name, "Timed Out Title", "T3 session named after timeout recovery");
}

// =====================================================================
// T4 — AC2 core: manual iron rule (/name + /rename), plus AC4 completions
// =====================================================================
async function t4() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  // /name foo (built-in) — simulate: sets name, fires session_info_changed
  pi.setSessionName("foo");
  await tick();
  assertEq(pi.name, "foo", "T4 /name foo applied");

  // first-naming must skip entirely (manual)
  setComplete(okComplete("Auto Foo"));
  pushMessages(pi, ["x1", "x2", "x3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T4 first naming skipped for manual session");

  // continuous must also skip (enable it, advance past thresholds)
  await cmd(pi, "rename-config", "continuous on");
  pushMessages(pi, ["y1", "y2", "y3", "y4"]);
  clock.now += 6 * 60 * 1000;
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T4 continuous skipped for manual session");

  // /rename bar — direct manual set
  await cmd(pi, "rename", "bar");
  assertEq(pi.name, "bar", "T4 /rename bar applied");
  const stateEntries = pi.entries.filter((e) => e.type === "custom" && e.customType === "pi-auto-rename:state");
  assertEq(stateEntries[stateEntries.length - 1]?.data?.source, "manual", "T4 /rename marked manual");

  // AC4 — argument completions
  const rc = pi.commands.get("rename-config");
  assert(rc && typeof rc.getArgumentCompletions === "function", "T4 rename-config registers completions");
  const subs = rc.getArgumentCompletions("c");
  assertEq(JSON.stringify(subs), JSON.stringify([{ value: "continuous", label: "continuous" }]), "T4 subcommand completion 'c' -> continuous");
  const modelVals = rc.getArgumentCompletions("model ");
  assert(modelVals && modelVals.some((v) => v.value === "faux/model-a"), "T4 model completion includes faux/model-a");
  const styleVals = rc.getArgumentCompletions("style ");
  assert(styleVals && styleVals.some((v) => v.value === "concise"), "T4 style completion includes concise");
  const boolVals = rc.getArgumentCompletions("auto ");
  assertEq(JSON.stringify(boolVals), JSON.stringify([{ value: "on", label: "on" }, { value: "off", label: "off" }]), "T4 auto completion on|off");
}

// =====================================================================
// T5 — AC5: continuous thresholds + KEEP
// =====================================================================
async function t5() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  setComplete(okComplete("Title A"));
  pushMessages(pi, ["a1", "a2", "a3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.name, "Title A", "T5 first naming applied");

  // +3 msgs but only +4min -> interval not met -> no evaluation
  pushMessages(pi, ["b1", "b2", "b3"]);
  clock.now += 4 * 60 * 1000;
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T5 no eval below 5min interval");

  // now +6min from lastAutoTime, >=3 new msgs -> eval -> KEEP
  setComplete(okComplete("KEEP"));
  clock.now += 2 * 60 * 1000;
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T5 eval ran at 6min");
  assertEq(pi.name, "Title A", "T5 KEEP -> title unchanged");
  const renamedNotifs = pi.notifications.filter((n) => n.message.includes("renamed"));
  assertEq(renamedNotifs.length, 0, "T5 no rename notify on KEEP");

  // topic shift -> new title
  pushMessages(pi, ["c1", "c2", "c3"]);
  clock.now += 6 * 60 * 1000;
  setComplete(okComplete("Title B"));
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 3, "T5 second eval ran");
  assertEq(pi.name, "Title B", "T5 topic shift -> renamed to Title B");
  assert(renamedNotifs.length >= 1 || pi.notifications.some((n) => n.message.includes("renamed: Title B")), "T5 'renamed' notify present");
  const latest = pi.entries.filter((e) => e.type === "custom" && e.customType === "pi-auto-rename:state").pop();
  assertEq(latest?.data?.source, "auto", "T5 continuous rename persisted as auto");
}

// =====================================================================
// T6 — AC7: resume restores manual flag and continuous auto state
// =====================================================================
async function t6() {
  // Part A: manual survives restart
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    await cmd(pi, "rename", "Persisted Name");
    assertEq(pi.name, "Persisted Name", "T6A manual rename applied");

    // simulate restart: same entries, fire session_start again
    await fire(pi, "session_start");
    await tick();
    setComplete(okComplete("Auto After Resume"));
    pushMessages(pi, ["r1", "r2", "r3"]);
    await fire(pi, "message_end");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 0, "T6A manual flag survived restart — no auto naming");
    assertEq(pi.name, "Persisted Name", "T6A name intact after restart");
  }

  // Part B: auto state (lastAutoTime) survives restart -> continuous works
  {
    writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
    const pi = makePi({});
    const mod = await import("../index.ts");
    // pre-seed an already-named session with an auto state entry (like a resumed session)
    pushMessages(pi, ["p1", "p2", "p3"]);
    pi.appendEntry("pi-auto-rename:state", { name: "Old Auto", source: "auto", timestamp: clock.now });
    pi.name = "Old Auto";
    mod.default(pi);
    await fire(pi, "session_start");
    await tick();
    assertEq(pi.name, "Old Auto", "T6B resumed session keeps name");

    pushMessages(pi, ["q1", "q2", "q3", "q4"]);
    clock.now += 6 * 60 * 1000;
    setComplete(okComplete("Resumed New Title"));
    await fire(pi, "agent_settled");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T6B continuous works after resume (auto state restored)");
    assertEq(pi.name, "Resumed New Title", "T6B renamed after resume");
  }
}

// =====================================================================
// T7 — AC3: /rename with arg + /rename (AI from full history)
// =====================================================================
async function t7() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  // /rename <name> direct
  await cmd(pi, "rename", "bar");
  assertEq(pi.name, "bar", "T7 /rename bar applied");
  assert(pi.notifications.some((n) => n.message === "Session named: bar"), "T7 notify on manual rename");

  // /rename (no args) -> AI from full history
  pushMessages(pi, ["long message one ".repeat(200), "second message", "third message"]);
  const seen = [];
  setComplete(async (_m, context, _o) => {
    seen.push(context);
    return { stopReason: "stop", content: [{ type: "text", text: "History Title" }], usage: {} };
  });
  await cmd(pi, "rename", "");
  await tick();
  assertEq(pi.name, "History Title", "T7 AI rename from history applied");
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T7 exactly 1 history call");
  const userText = seen[0].messages[0].content[0].text;
  assert(userText.includes("Conversation history:"), "T7 history prompt used");
  assert(userText.length <= 8000 + 200, `T7 history input truncated <= 8000 (got ${userText.length})`);
  const latest = pi.entries.filter((e) => e.type === "custom" && e.customType === "pi-auto-rename:state").pop();
  assertEq(latest?.data?.source, "manual", "T7 /rename (AI) marks manual");

  // /rename on empty session -> warning, no crash
  const pi2 = makePi({});
  mod.default(pi2);
  await fire(pi2, "session_start");
  await cmd(pi2, "rename", "");
  assert(pi2.notifications.some((n) => n.message.includes("No conversation history")), "T7 empty-history warning");
}

// =====================================================================
// T8 — AC8: sanitizeName + prompt builders
// =====================================================================
async function t8() {
  const { sanitizeName, buildSystemPrompt, buildUserPrompt, MAX_TITLE_LENGTH } = await import("../naming.ts");
  assertEq(sanitizeName('"Hello World"'), "Hello World", "T8 strips double quotes");
  assertEq(sanitizeName("'Hi'"), "Hi", "T8 strips single quotes");
  assertEq(sanitizeName("“中文标题。”"), "中文标题", "T8 strips Chinese quotes + trailing punct");
  assertEq(sanitizeName("Hello World!"), "Hello World", "T8 drops trailing punctuation");
  assertEq(sanitizeName("  Hello   World  "), "Hello World", "T8 collapses whitespace");
  assertEq(sanitizeName("line1\nline2"), "line1", "T8 first line only");
  const long = "x".repeat(100);
  assertEq(sanitizeName(long).length, MAX_TITLE_LENGTH, "T8 hard cap 80 chars");
  assertEq(sanitizeName("   "), null, "T8 blank -> null");

  const sys = buildSystemPrompt({ style: "concise", autoRename: true, continuousRename: false, language: "auto" });
  assert(sys.includes("Concise: ≤ 12 Chinese characters or 2-6 English words"), "T8 concise style line");
  assert(sys.includes("Match the primary language"), "T8 language-follow line");
  const sysZh = buildSystemPrompt({ style: "formal", autoRename: true, continuousRename: false, language: "zh" });
  assert(sysZh.includes("Formal, written tone"), "T8 formal style line");
  assert(sysZh.includes("Always write the title in Chinese"), "T8 forced zh line");
  const sysCustom = buildSystemPrompt({ style: "custom", customStyle: "emoji-free haiku", autoRename: true, continuousRename: false, language: "en" });
  assert(sysCustom.includes("emoji-free haiku"), "T8 custom style text");
  const upd = buildUserPrompt("update", "recent content", "Cur Title");
  const updText = upd.content[0].text;
  assert(updText.includes("Current title: Cur Title"), "T8 update prompt carries current title");
  assert(updText.includes("Reply KEEP if the title still fits"), "T8 update prompt KEEP instruction");
}

// =====================================================================
// T9 — R10: config read/write round-trip via the canonical path
// =====================================================================
async function t9() {
  // Partial config: missing fields fall back to defaults; explicit fields kept.
  writeConfig({ style: "formal", autoRename: false });
  const { loadConfig } = await import("../config.ts");
  const cfg = loadConfig();
  assertEq(cfg.style, "formal", "T9 explicit style kept");
  assertEq(cfg.autoRename, false, "T9 explicit autoRename kept");
  assertEq(cfg.continuousRename, false, "T9 missing continuousRename defaults to false");
  assertEq(cfg.language, "auto", "T9 missing language defaults to auto");
  assertEq(cfg.model, undefined, "T9 absent model override stays undefined");
}

// =====================================================================
// =====================================================================
// T10 — naming call contract: registry path, maxTokens/signal forwarded
// =====================================================================
async function t10() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");
  setComplete(okComplete("Contract Title"));
  pushMessages(pi, ["z1", "z2", "z3"]);
  await fire(pi, "message_end");
  await tick();
  const call = globalThis.__ARN__.completeCalls[0];
  assertEq(call.options.maxTokens, 64, "T10 maxTokens = 64");
  assert(!!call.options.signal, "T10 abort signal forwarded");
  assertEq(call.options.apiKey, undefined, "T10 extension does not pass apiKey — the registry resolves auth");
  assertEq(call.options.headers, undefined, "T10 extension does not pass headers — the registry resolves auth");
  assertEq(call.model.provider, "faux", "T10 default naming model follows session model (faux)");
  assertEq(call.model.id, "model-a", "T10 session model id used");
  const sys = call.context.systemPrompt;
  assert(sys.includes("You create short, descriptive titles"), "T10 system prompt passed");
  assertEq(globalThis.__ARN__.compatCalls.length, 0, "T10 naming never falls back to @earendil-works/pi-ai/compat");
}

// =====================================================================
// T11 — regression: provider-extension api id (cliproxyapi-style) names fine
//       Before the registry switch this produced
//       "Auto rename skipped: No API provider registered for api:
//        cliproxyapi-codex-responses" and left the session unnamed.
// =====================================================================
async function t11() {
  writeConfig({
    autoRename: true,
    continuousRename: false,
    style: "concise",
    language: "auto",
    model: { provider: "cliproxy", id: "codex-model" },
  });
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");
  setComplete(okComplete("Custom Api Title"));
  pushMessages(pi, ["k1", "k2", "k3"]);
  await fire(pi, "message_end");
  await tick();

  const call = globalThis.__ARN__.completeCalls[0];
  assertEq(call?.model?.api, "cliproxyapi-codex-responses", "T11 override model keeps its extension api id");
  assertEq(pi.name, "Custom Api Title", "T11 session named through the registry");
  const warnings = pi.notifications.filter((n) => n.level === "warning");
  assertEq(warnings.length, 0, "T11 no 'No API provider registered for api' warning");
  assertEq(globalThis.__ARN__.compatCalls.length, 0, "T11 naming never falls back to @earendil-works/pi-ai/compat");
}

// =====================================================================
// T12 — R1 nonblocking: every automatic handler returns while the title
//       request is unresolved (provider ignores abort and never settles)
// =====================================================================
async function t12() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });

  // session_start
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    globalThis.__ARN__.completeCalls = [];
    pushMessages(pi, ["s1", "s2", "s3"]);
    setComplete(neverComplete());
    let settled = false;
    const p = fireAsync(pi, "session_start").then(() => {
      settled = true;
    });
    await tick();
    assert(settled, "T12 session_start returned while the title request was unresolved");
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T12 session_start dispatched exactly one title request");
    assertEq(pendingTimerCount(), 1, "T12 session_start left the independent deadline armed");
    await fire(pi, "session_shutdown", { reason: "quit" });
    await tick();
    await tick();
    assertEq(pendingTimerCount(), 0, "T12 shutdown cleared the deadline timer");
    await p;
  }

  // message_end
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    globalThis.__ARN__.completeCalls = [];
    await fire(pi, "session_start");
    pushMessages(pi, ["m1", "m2", "m3"]);
    setComplete(neverComplete());
    let settled = false;
    const p = fireAsync(pi, "message_end").then(() => {
      settled = true;
    });
    await tick();
    assert(settled, "T12 message_end returned while the title request was unresolved");
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T12 message_end dispatched exactly one title request");
    await fire(pi, "session_shutdown", { reason: "quit" });
    await tick();
    await tick();
    await p;
  }

  // agent_settled (continuous)
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    globalThis.__ARN__.completeCalls = [];
    await fire(pi, "session_start");
    setComplete(okComplete("Base Title"));
    pushMessages(pi, ["a1", "a2", "a3"]);
    await fire(pi, "message_end");
    await tick();
    assertEq(pi.name, "Base Title", "T12 continuous base name set");

    pushMessages(pi, ["b1", "b2", "b3"]);
    clock.now += 6 * 60 * 1000;
    setComplete(neverComplete());
    let settled = false;
    const p = fireAsync(pi, "agent_settled").then(() => {
      settled = true;
    });
    await tick();
    assert(settled, "T12 agent_settled returned while the title request was unresolved");
    assertEq(globalThis.__ARN__.completeCalls.length, 2, "T12 agent_settled dispatched the continuous title request");
    await fire(pi, "session_shutdown", { reason: "quit" });
    await tick();
    await tick();
    await p;
  }
}

// =====================================================================
// T13 — single flight: repeated events during a pending request launch none
// =====================================================================
async function t13() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["f1", "f2", "f3"]);
  const p1 = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T13 first title request dispatched");

  const p2 = fireAsync(pi, "message_end");
  const p3 = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T13 single-flight: repeated events did not duplicate the request");

  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "First Title" }], usage: {} });
  await p1;
  await p2;
  await p3;
  await tick();
  assertEq(pi.name, "First Title", "T13 the single request applied");
}

// =====================================================================
// T14 — session_shutdown cancels: stale success is silent, no cooldown
// =====================================================================
async function t14() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["g1", "g2", "g3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T14 request in flight");

  await fire(pi, "session_shutdown", { reason: "reload" });
  await tick();
  assertEq(pendingTimerCount(), 0, "T14 shutdown cleared the title deadline timer");

  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Too Late" }], usage: {} });
  await pending;
  await tick();
  await tick();
  assertEq(pi.name, undefined, "T14 late success after shutdown did not set the name");
  assertEq(pi.notifications.filter((n) => n.level === "warning").length, 0, "T14 lifecycle cancellation produced no stale warning");
  assertEq(pi.notifications.filter((n) => n.message.includes("Session named")).length, 0, "T14 lifecycle cancellation produced no stale notification");

  // No failure cooldown was recorded: an immediate retry is allowed.
  setComplete(okComplete("Fresh Title"));
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T14 no cooldown after lifecycle cancellation (retry ran)");
  assertEq(pi.name, "Fresh Title", "T14 retry after cancellation named the session");
}

// =====================================================================
// T15 — branch navigation invalidates branch-bound work
// =====================================================================
async function t15() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["t1", "t2", "t3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T15 request in flight");

  await fire(pi, "session_before_tree", { preparation: {}, signal: new AbortController().signal });
  await tick();
  assertEq(pendingTimerCount(), 0, "T15 before_tree cancelled the pending title");
  await fire(pi, "session_tree", { newLeafId: "x", oldLeafId: "y" });
  await tick();

  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Stale Tree Title" }], usage: {} });
  await pending;
  await tick();
  await tick();
  assertEq(pi.name, undefined, "T15 stale branch result did not apply after tree navigation");
  assertEq(pi.notifications.filter((n) => n.level === "warning").length, 0, "T15 no warning for superseded branch work");
}

// =====================================================================
// T16 — manual rename supersedes an in-flight first naming (silent)
// =====================================================================
async function t16() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["u1", "u2", "u3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();
  pi.setSessionName("User Name");
  await tick();
  assertEq(pi.name, "User Name", "T16 manual rename applied");

  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Auto Loser" }], usage: {} });
  await pending;
  await tick();
  await tick();
  assertEq(pi.name, "User Name", "T16 auto result dropped after manual rename");
  assertEq(pi.notifications.filter((n) => n.message.includes("named:")).length, 0, "T16 no stale auto 'named' notification");
  assertEq(pi.notifications.filter((n) => n.level === "warning").length, 0, "T16 manual supersession is silent");
}

// =====================================================================
// T17 — disabling a mode invalidates only the affected automatic request
// =====================================================================
async function t17() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");
  setComplete(okComplete("Base"));
  pushMessages(pi, ["c1", "c2", "c3"]);
  await fire(pi, "message_end");
  await tick();

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["c4", "c5", "c6"]);
  clock.now += 6 * 60 * 1000;
  const pending = fireAsync(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T17 continuous request in flight");

  await cmd(pi, "rename-config", "continuous off");
  await tick();
  assertEq(pendingTimerCount(), 0, "T17 disabling continuous cancelled the pending continuous title");
  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Should Not Apply" }], usage: {} });
  await pending;
  await tick();
  await tick();
  assertEq(pi.name, "Base", "T17 disabled-mode result did not rename");
  assertEq(pi.notifications.filter((n) => n.level === "warning").length, 0, "T17 mode-disable cancellation is silent");
}

// =====================================================================
// T18 — a stale request's finally must not release a newer owner
// =====================================================================
async function t18() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const a = abortResistantComplete();
  setComplete(a.fn);
  pushMessages(pi, ["x1", "x2", "x3"]);
  const pa = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T18 request A dispatched");

  // Supersede A, then start B.
  await fire(pi, "session_shutdown", { reason: "reload" });
  await tick();
  const b = abortResistantComplete();
  setComplete(b.fn);
  const pb = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T18 request B dispatched after A was superseded");

  // Resolve A late: its finally must not release B's single-flight guard.
  a.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Late A" }], usage: {} });
  await pa;
  await tick();
  const pExtra = fireAsync(pi, "message_end");
  await tick();
  await pExtra;
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T18 stale A did not release B's single-flight guard");
  assertEq(pi.name, undefined, "T18 stale A did not set the name");

  b.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Fresh B" }], usage: {} });
  await pb;
  await tick();
  assertEq(pi.name, "Fresh B", "T18 the newer request B still applied");
}

// =====================================================================
// T19 — a normal message append must not stale a valid title request
// =====================================================================
async function t19() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["n1", "n2", "n3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();

  // Normal appends advance the leaf; they must not invalidate the request.
  pushMessages(pi, ["n4"]);
  pushAssistant(pi, "n5");
  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Still Valid" }], usage: {} });
  await pending;
  await tick();
  assertEq(pi.name, "Still Valid", "T19 normal message appends did not invalidate the title request");
}

// =====================================================================
// T20 — independent deadline and cancellation in generateName
// =====================================================================
async function t20() {
  const { generateName } = await import("../naming.ts");
  const cfg = { autoRename: true, continuousRename: false, style: "concise", language: "auto" };

  // (a) no external signal + abort-ignoring provider -> local deadline
  {
    const pi = makePi({});
    const ctx = makeCtx(pi);
    let capturedSignal;
    setComplete((_m, _c, options) => {
      capturedSignal = options.signal;
      return new Promise(() => {});
    });
    const p = generateName(ctx, cfg, "first", "hi");
    await tick();
    assertEq(pendingTimerCount(), 1, "T20a deadline timer armed without an external signal");
    clock.now += 30_000;
    fireAllTimers();
    const result = await p;
    assertEq(result.reason, "timeout", "T20a settled locally with a timeout reason");
    assertEq(capturedSignal.aborted, true, "T20a provider signal was aborted");
    assertEq(pendingTimerCount(), 0, "T20a timer cleaned up");
  }

  // (b) external signal that never aborts -> still an independent deadline
  {
    const pi = makePi({});
    const ctx = makeCtx(pi);
    const external = new AbortController();
    setComplete(neverComplete());
    const p = generateName(ctx, cfg, "first", "hi", { signal: external.signal });
    await tick();
    assertEq(pendingTimerCount(), 1, "T20b deadline timer armed despite an external signal");
    fireAllTimers();
    const result = await p;
    assertEq(result.reason, "timeout", "T20b independent deadline still fired");
    assertEq(pendingTimerCount(), 0, "T20b timer cleaned up");
  }

  // (c) already-aborted external signal -> immediate cancellation, no dispatch
  {
    const pi = makePi({});
    const ctx = makeCtx(pi);
    const external = new AbortController();
    external.abort();
    globalThis.__ARN__.completeCalls = [];
    setComplete(() => {
      throw new Error("must not dispatch");
    });
    const result = await generateName(ctx, cfg, "first", "hi", { signal: external.signal });
    assertEq(result.reason, "cancelled", "T20c pre-aborted signal cancelled immediately");
    assertEq(globalThis.__ARN__.completeCalls.length, 0, "T20c pre-aborted signal did not dispatch");
    assertEq(pendingTimerCount(), 0, "T20c no timer left behind");
  }

  // (d) external abort mid-flight -> cancelled + cleanup
  {
    const pi = makePi({});
    const ctx = makeCtx(pi);
    const external = new AbortController();
    setComplete(neverComplete());
    const p = generateName(ctx, cfg, "first", "hi", { signal: external.signal });
    await tick();
    external.abort();
    const result = await p;
    assertEq(result.reason, "cancelled", "T20d upstream abort settled as cancelled");
    assertEq(pendingTimerCount(), 0, "T20d timer cleaned up");
  }
}

// =====================================================================
// T21 — a late provider rejection is contained (no unhandledRejection)
// =====================================================================
async function t21() {
  const { generateName } = await import("../naming.ts");
  const cfg = { autoRename: true, continuousRename: false, style: "concise", language: "auto" };
  const pi = makePi({});
  const ctx = makeCtx(pi);
  let rejectLate;
  setComplete(() => new Promise((_res, rej) => {
    rejectLate = rej;
  }));
  const p = generateName(ctx, cfg, "first", "hi");
  await tick();
  fireAllTimers();
  const result = await p;
  assertEq(result.reason, "timeout", "T21 settled on the local deadline");
  rejectLate(new Error("late provider failure"));
  await tick();
  await tick();
  assertEq(unhandledRejections.length, 0, "T21 late provider rejection was contained");
}

// =====================================================================
// T22 — awaited /rename (AI) drops a result after a session/branch or name change
// =====================================================================
async function t22() {
  // (a) session transition while the command awaits its title
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["h1", "h2", "h3"]);

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T22a history rename dispatched");

    await fire(pi, "session_shutdown", { reason: "new" });
    await tick();
    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Stale Command Title" }], usage: {} });
    await running;
    await tick();
    assertEq(pi.name, undefined, "T22a session transition dropped the manual AI title");
  }

  // (b) a later external rename wins over the in-flight manual command
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["k1", "k2", "k3"]);

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    pi.setSessionName("User Wins");
    await tick();
    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Command Title" }], usage: {} });
    await running;
    await tick();
    assertEq(pi.name, "User Wins", "T22b later rename won over the in-flight manual AI result");
  }
}

// =====================================================================
// T23 — auto-off cancels an in-flight first naming (silent)
// =====================================================================
async function t23() {
  const pi = makePi({});
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  const hang = abortResistantComplete();
  setComplete(hang.fn);
  pushMessages(pi, ["a1", "a2", "a3"]);
  const pending = fireAsync(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T23 first request in flight");

  await cmd(pi, "rename-config", "auto off");
  await tick();
  assertEq(pendingTimerCount(), 0, "T23 auto-off cancelled the pending first request");
  hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Should Not Apply" }], usage: {} });
  await pending;
  await tick();
  await tick();
  assertEq(pi.name, undefined, "T23 auto-off result did not apply");
  assertEq(pi.notifications.filter((n) => n.level === "warning").length, 0, "T23 auto-off cancellation is silent");
}

// =====================================================================
// T24 — explicit /rename (AI) request ownership: clear, ABA, newer request,
//       auto suspension during the command, and shutdown cancellation
// =====================================================================
async function t24() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });

  // (a) explicit clear while /rename (AI) is pending must win
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["h1", "h2", "h3"]);
    globalThis.__ARN__.completeCalls = [];

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24a history rename dispatched");

    // The name was undefined and the user explicitly clears it again: name
    // equality alone (undefined === undefined) must not let the result apply.
    pi.setSessionName(undefined);
    await tick();
    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Stale Clear Title" }], usage: {} });
    await running;
    await tick();
    await tick();
    assertEq(pi.name, undefined, "T24a explicit clear during pending /rename wins");
    assertEq(pi.notifications.filter((n) => n.message.includes("Session named")).length, 0, "T24a no stale manual notification");
  }

  // (b) same-name ABA (A -> B -> A) during /rename (AI) must not overwrite
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["a1", "a2", "a3"]);
    pi.setSessionName("A");
    await tick();
    globalThis.__ARN__.completeCalls = [];

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24b history rename dispatched");

    pi.setSessionName("B");
    await tick();
    pi.setSessionName("A");
    await tick();
    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "ABA Winner" }], usage: {} });
    await running;
    await tick();
    await tick();
    assertEq(pi.name, "A", "T24b same-name ABA did not let the stale result apply");
  }

  // (c) a newer manual /rename (AI) supersedes the earlier one
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["n1", "n2", "n3"]);
    globalThis.__ARN__.completeCalls = [];

    const first = abortResistantComplete();
    setComplete(first.fn);
    const runningFirst = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24c first history rename dispatched");

    const second = abortResistantComplete();
    setComplete(second.fn);
    const runningSecond = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 2, "T24c second history rename dispatched");

    second.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Second Title" }], usage: {} });
    await runningSecond;
    await tick();
    assertEq(pi.name, "Second Title", "T24c newer manual request applied");

    first.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "First Title" }], usage: {} });
    await runningFirst;
    await tick();
    await tick();
    assertEq(pi.name, "Second Title", "T24c superseded manual request did not overwrite the newer one");
  }

  // (d) automatic events during a pending /rename (AI) must not dispatch auto work
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    setComplete(okComplete("Base"));
    pushMessages(pi, ["g1", "g2", "g3"]);
    await fire(pi, "message_end");
    await tick();
    assertEq(pi.name, "Base", "T24d base name set");
    globalThis.__ARN__.completeCalls = [];

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24d manual request in flight");

    pushMessages(pi, ["g4", "g5", "g6"]);
    clock.now += 6 * 60 * 1000;
    await fire(pi, "message_end");
    await fire(pi, "agent_settled");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24d auto events did not dispatch while the manual request was pending");

    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Manual Title" }], usage: {} });
    await running;
    await tick();
    assertEq(pi.name, "Manual Title", "T24d manual request applied after auto was suspended");
  }

  // (e) session_shutdown cancels a pending /rename (AI)
  {
    const pi = makePi({});
    const mod = await import("../index.ts");
    mod.default(pi);
    await fire(pi, "session_start");
    pushMessages(pi, ["s1", "s2", "s3"]);
    globalThis.__ARN__.completeCalls = [];

    const hang = abortResistantComplete();
    setComplete(hang.fn);
    const running = cmdAsync(pi, "rename", "");
    await tick();
    assertEq(globalThis.__ARN__.completeCalls.length, 1, "T24e manual request in flight");

    await fire(pi, "session_shutdown", { reason: "reload" });
    await tick();
    assertEq(pendingTimerCount(), 0, "T24e shutdown cleared the manual request deadline");
    hang.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Too Late Manual" }], usage: {} });
    await running;
    await tick();
    await tick();
    assertEq(pi.name, undefined, "T24e shutdown cancelled the pending manual request");

    // Failure/cancellation restores automatic eligibility (no permanent manual).
    setComplete(okComplete("Auto After Manual Cancel"));
    await fire(pi, "message_end");
    await tick();
    assertEq(pi.name, "Auto After Manual Cancel", "T24e automatic naming recovered after manual cancellation");
  }
}

// =====================================================================
// T25 — generateName always releases its deadline timer and listeners
// =====================================================================
async function t25() {
  const { generateName } = await import("../naming.ts");
  const cfg = { autoRename: true, continuousRename: false, style: "concise", language: "auto" };

  // success path releases the timer
  {
    const pi = makePi({});
    const ctx = makeCtx(pi);
    setComplete(okComplete("Clean Title"));
    const external = new AbortController();
    const result = await generateName(ctx, cfg, "first", "hi", { signal: external.signal });
    assertEq(result.name, "Clean Title", "T25 success path returned a name");
    assertEq(pendingTimerCount(), 0, "T25 success path released the deadline timer");
    // Aborting the (now irrelevant) upstream signal must be harmless.
    external.abort();
    assertEq(result.name, "Clean Title", "T25 late upstream abort did not disturb the settled result");
  }

  // auth/provider failure path releases the timer
  {
    const pi = makePi({ sessionModel: MODELS.nokey["model-b"] });
    const ctx = makeCtx(pi);
    const result = await generateName(ctx, cfg, "first", "hi");
    assert(!!result.error, "T25 auth failure returned an error");
    assertEq(pendingTimerCount(), 0, "T25 auth failure released the deadline timer");
  }
}

// =====================================================================
// T26 — actual session replacement and stale contexts/errors/finalizers.
// Start the newer request before the cancelled owner's continuation runs.
// =====================================================================
async function t26() {
  const pi = makePi({ sessionId: "outgoing" });
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");
  pushMessages(pi, ["outgoing history"]);
  const oldCtx = makeCtx(pi);
  let oldContextInvalid = false;
  let staleReads = 0;
  for (const key of ["model", "modelRegistry", "sessionManager", "ui"]) {
    const value = oldCtx[key];
    Object.defineProperty(oldCtx, key, { get() {
      if (oldContextInvalid) {
        staleReads++;
        throw new Error("outgoing context was invalidated");
      }
      return value;
    } });
  }
  let rejectOld;
  setComplete(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  await pi.handlers.get("message_end")({}, oldCtx);
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T26 outgoing request dispatched");

  // No await between invalidation and reservation of the incoming owner.
  const shutdown = fireAsync(pi, "session_shutdown", { reason: "new" });
  oldContextInvalid = true;
  pi._opts.sessionId = "incoming";
  pi.entries = [];
  pushMessages(pi, ["incoming history"]);
  const incoming = abortResistantComplete();
  setComplete(incoming.fn);
  const start = fireAsync(pi, "session_start", { reason: "new" });
  await Promise.all([shutdown, start]);
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T26 incoming session reserved its request");
  rejectOld(new Error("late outgoing provider failure"));
  await tick();
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T26 old finalizer/error did not release the newer guard");
  assertEq(staleReads, 0, "T26 old context was never accessed after invalidation");
  assertEq(pi.notifications.length, 0, "T26 late outgoing failure caused no stale notification");
  assertEq(pi.entries.filter((e) => e.type === "custom").length, 0, "T26 stale failure wrote no incoming state");
  incoming.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Incoming Title" }] });
  await tick();
  assertEq(pi.name, "Incoming Title", "T26 incoming owner still applied");
  assertEq(unhandledRejections.length, 0, "T26 late outgoing rejection was contained");
}

// =====================================================================
// T27 — manual failure restores eligibility; config-off never cancels manual.
// =====================================================================
async function t27() {
  const mod = await import("../index.ts");
  const pi = makePi({});
  mod.default(pi);
  await fire(pi, "session_start");
  pushMessages(pi, ["history"]);
  const auto = abortResistantComplete();
  setComplete(auto.fn);
  await fire(pi, "message_end");
  await tick();
  const autoSignal = globalThis.__ARN__.completeCalls[0].options.signal;
  let rejectManual;
  setComplete(() => new Promise((_resolve, reject) => { rejectManual = reject; }));
  const manual = cmdAsync(pi, "rename", "");
  await tick();
  assertEq(autoSignal.aborted, true, "T27 manual AI superseded the automatic request");
  await fire(pi, "message_end");
  assertEq(globalThis.__ARN__.completeCalls.length, 2, "T27 automatic events were suspended during manual AI");
  rejectManual(new Error("manual provider failed"));
  await manual;
  assertEq(pi.entries.filter((e) => e.type === "custom").length, 0, "T27 failed manual AI did not mark the session manual");
  assertEq(pi.notifications.filter((n) => n.level === "error").length, 1, "T27 current manual failure reported once");
  setComplete(okComplete("Recovery"));
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.name, "Recovery", "T27 automatic naming was immediately eligible after manual failure");
  auto.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Stale Auto" }] });
  await tick();
  assertEq(pi.name, "Recovery", "T27 superseded auto success did not overwrite recovery");

  const pending = abortResistantComplete();
  setComplete(pending.fn);
  const explicit = cmdAsync(pi, "rename", "");
  await tick();
  const explicitSignal = globalThis.__ARN__.completeCalls.at(-1).options.signal;
  await cmd(pi, "rename-config", "auto off");
  await cmd(pi, "rename-config", "continuous off");
  assertEq(explicitSignal.aborted, false, "T27 disabling automatic modes did not cancel explicit AI");
  pending.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Explicit Still Works" }] });
  await explicit;
  assertEq(pi.name, "Explicit Still Works", "T27 explicit AI remained usable with automatic modes off");
}

// =====================================================================
// T28 — directly count owned listeners on every generateName exit path.
// =====================================================================
async function t28() {
  const { generateName } = await import("../naming.ts");
  const cfg = { autoRename: true, continuousRename: false, style: "concise", language: "auto" };
  for (const outcome of ["success", "provider-failure", "timeout", "cancel", "pre-aborted"]) {
    const external = new AbortController();
    let providerSignal;
    setComplete((_model, _context, options) => {
      providerSignal = options.signal;
      if (outcome === "success") return okComplete("Listeners Clean")();
      if (outcome === "provider-failure") return Promise.reject(new Error("provider failure"));
      return new Promise(() => {});
    });
    if (outcome === "pre-aborted") external.abort();
    const resultPromise = generateName(makeCtx(makePi({ signal: external.signal })), cfg, "first", "hi");
    if (outcome === "timeout" || outcome === "cancel") {
      await tick();
      assertEq(getEventListeners(external.signal, "abort").length, 1, `T28 ${outcome}: upstream listener attached`);
      assertEq(getEventListeners(providerSignal, "abort").length, 1, `T28 ${outcome}: local listener attached`);
      if (outcome === "timeout") fireAllTimers();
      else external.abort();
    }
    await resultPromise;
    assertEq(getEventListeners(external.signal, "abort").length, 0, `T28 ${outcome}: upstream listener removed`);
    if (providerSignal) assertEq(getEventListeners(providerSignal, "abort").length, 0, `T28 ${outcome}: local listener removed`);
    assertEq(pendingTimerCount(), 0, `T28 ${outcome}: timer removed`);
    if (outcome !== "cancel" && outcome !== "pre-aborted") assertEq(external.signal.aborted, false, `T28 ${outcome}: upstream controller was not aborted`);
  }

  // Automatic work must not inherit the primary Agent's cancellation source.
  const primary = new AbortController();
  const pi = makePi({ signal: primary.signal });
  (await import("../index.ts")).default(pi);
  await fire(pi, "session_start");
  pushMessages(pi, ["hello"]);
  const pending = abortResistantComplete();
  setComplete(pending.fn);
  await fire(pi, "message_end");
  await tick();
  primary.abort();
  pending.d.resolve({ stopReason: "stop", content: [{ type: "text", text: "Session Owned" }] });
  await tick();
  assertEq(pi.name, "Session Owned", "T28 primary Agent abort did not cancel session-owned automatic naming");
}

// =====================================================================
// T29 — tree navigation does not confuse historical auto state with manual.
// =====================================================================
async function t29() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({});
  (await import("../index.ts")).default(pi);
  await fire(pi, "session_start");
  pushMessages(pi, ["old branch"]);
  setComplete(okComplete("File Wide Name"));
  await fire(pi, "message_end");
  await tick();
  await fire(pi, "session_before_tree");
  pi.entries = [];
  pushMessages(pi, ["historical branch"]);
  pi.appendEntry("pi-auto-rename:state", { name: "Historical Auto Name", source: "auto", timestamp: clock.now });
  await fire(pi, "session_tree");
  assertEq(pi.name, "File Wide Name", "T29 tree kept the file-wide title");
  clock.now += FIVE_MIN + 1;
  pushMessages(pi, ["one new message", "two new messages"]);
  await fire(pi, "agent_settled");
  assertEq(globalThis.__ARN__.completeCalls.length, 1, "T29 tree refreshed the message threshold");
  pushMessages(pi, ["three new messages"]);
  setComplete(okComplete("Current Branch Title"));
  await fire(pi, "agent_settled");
  await tick();
  assertEq(pi.name, "Current Branch Title", "T29 historical auto state did not falsely install a manual flag");
}

// =====================================================================
// T30 — naming notifications are terminal-only (pi-web runs extensions as rpc)
// =====================================================================
async function t30() {
  writeConfig({ autoRename: true, continuousRename: true, style: "concise", language: "auto" });
  const pi = makePi({ mode: "rpc", sessionModel: MODELS.nokey["model-b"] });
  const mod = await import("../index.ts");
  mod.default(pi);
  await fire(pi, "session_start");

  // Automatic failure: silent off-terminal, but the retry breaker still applies.
  pushMessages(pi, ["q1", "q2", "q3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.notifications.length, 0, "T30 rpc: no warning for a failed automatic naming");
  KEY_POLICY.nokey = { ok: true, apiKey: "now-key", headers: {} };
  setComplete(okComplete("Too Early"));
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T30 rpc: failure cooldown still recorded");

  // Automatic success: the title is applied without a notification.
  clock.now += FIVE_MIN + 1000;
  setComplete(okComplete("Web Title"));
  await fire(pi, "message_end");
  await tick();
  assertEq(pi.name, "Web Title", "T30 rpc: first naming applied");

  // Continuous rename: applied without a notification.
  pushMessages(pi, ["c1", "c2", "c3"]);
  clock.now += 6 * 60 * 1000;
  setComplete(okComplete("Web Title B"));
  await fire(pi, "agent_settled");
  await tick();
  assertEq(pi.name, "Web Title B", "T30 rpc: continuous rename applied");

  // Continuous failure: silent.
  pushMessages(pi, ["d1", "d2", "d3"]);
  clock.now += 6 * 60 * 1000;
  setComplete(okComplete("   "));
  await fire(pi, "agent_settled");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 3, "T30 rpc: continuous failure path ran");

  // Manual /rename <name>: the sidebar title is the feedback, no toast.
  await cmd(pi, "rename", "Typed Name");
  assertEq(pi.name, "Typed Name", "T30 rpc: manual rename applied");
  assertEq(pi.notifications.length, 0, "T30 rpc: no naming notification of any kind");
}

// =====================================================================
// T31 — explicit command errors still reach non-terminal clients; tui unchanged
// =====================================================================
async function t31() {
  const web = makePi({ mode: "rpc", sessionModel: MODELS.nokey["model-b"] });
  const mod = await import("../index.ts");
  mod.default(web);
  await fire(web, "session_start");
  pushMessages(web, ["q1"]);
  await tick();
  web.notifications.length = 0;
  await cmd(web, "rename", "");
  assertEq(web.notifications.length, 1, "T31 rpc: explicit /rename (AI) failure is reported");
  assertEq(web.notifications[0]?.level, "error", "T31 rpc: reported as an error");

  const tui = makePi({ sessionModel: MODELS.nokey["model-b"] });
  mod.default(tui);
  await fire(tui, "session_start");
  pushMessages(tui, ["q1"]);
  await fire(tui, "message_end");
  await tick();
  assert(
    tui.notifications.some((n) => n.level === "warning" && n.message.includes("Auto rename skipped")),
    "T31 tui: automatic failure warning still shown",
  );
  KEY_POLICY.nokey = { ok: true, apiKey: "now-key", headers: {} };
  clock.now += FIVE_MIN + 1000;
  setComplete(okComplete("Terminal Title"));
  await fire(tui, "message_end");
  await tick();
  assert(
    tui.notifications.some((n) => n.message === "Session named: Terminal Title"),
    "T31 tui: success notification still shown",
  );
}

// =====================================================================
// T32 — expanded /skill: blocks are reduced to what the user typed
// =====================================================================
function skillBlock(name, body, args) {
  const block = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

function promptText(call) {
  return call?.context?.messages?.[0]?.content?.[0]?.text ?? "";
}

async function t32() {
  const body = "SKILLBODY ".repeat(1000);
  const mod = await import("../index.ts");

  // First naming: the user's words survive, the skill body does not.
  const pi = makePi({});
  mod.default(pi);
  await fire(pi, "session_start");
  setComplete(okComplete("Cache Layer"));
  pushMessages(pi, [skillBlock("brainstorming", body, "帮我设计一个缓存层")]);
  await fire(pi, "message_end");
  await tick();
  let text = promptText(globalThis.__ARN__.completeCalls[0]);
  assert(text.includes("User: 帮我设计一个缓存层"), "T32 first: user arguments kept");
  assert(!text.includes("SKILLBODY"), "T32 first: skill body dropped");
  assert(!text.includes("<skill"), "T32 first: skill wrapper dropped");

  // A bare /skill:name keeps only the command the user typed.
  const bare = makePi({});
  mod.default(bare);
  await fire(bare, "session_start");
  setComplete(okComplete("Brainstorm"));
  pushMessages(bare, [skillBlock("brainstorming", body)]);
  await fire(bare, "message_end");
  await tick();
  text = promptText(globalThis.__ARN__.completeCalls[1]);
  assert(text.includes("User: /skill:brainstorming"), "T32 bare: the typed command stands in");
  assert(!text.includes("SKILLBODY"), "T32 bare: skill body dropped");

  // /rename (AI) history: the body cannot crowd later messages out of the 8000-char cap.
  const hist = makePi({});
  mod.default(hist);
  await fire(hist, "session_start");
  pushMessages(hist, [
    skillBlock("brainstorming", body, "设计缓存"),
    { role: "assistant", text: "好的" },
    "最后改成用 Redis",
  ]);
  setComplete(okComplete("Redis Cache"));
  await cmd(hist, "rename", "");
  text = promptText(globalThis.__ARN__.completeCalls.at(-1));
  assert(!text.includes("SKILLBODY"), "T32 history: skill body dropped");
  assert(text.includes("最后改成用 Redis"), "T32 history: later messages kept");

  // Assistant text that merely looks like a skill block is left alone.
  const asst = makePi({});
  mod.default(asst);
  await fire(asst, "session_start");
  setComplete(okComplete("Quoted"));
  pushMessages(asst, ["hi", { role: "assistant", text: skillBlock("quoted", "ASSISTANT-QUOTE") }]);
  await cmd(asst, "rename", "");
  text = promptText(globalThis.__ARN__.completeCalls.at(-1));
  assert(text.includes("ASSISTANT-QUOTE"), "T32 assistant text untouched");
}

// =====================================================================
// runner
// =====================================================================
const tests = [
  ["T1a Major1 race: manual /name during continuous in-flight", t1a],
  ["T1b Major1 race: silent external rename (name re-check)", t1b],
  ["T1c Major1 race: user clears name during first-naming (applyAutoName insurance)", t1c],
  ["T2 Minor2: first-naming failure -> 5min breaker, 1 warning", t2],
  ["T3 Minor3: hung complete -> 30s timeout, inFlight released", t3],
  ["T4 AC2 manual iron rule + AC4 completions", t4],
  ["T5 AC5 continuous thresholds + KEEP", t5],
  ["T6 AC7 resume restores manual + auto state", t6],
  ["T7 AC3 /rename forms", t7],
  ["T8 AC8 sanitize + prompts", t8],
  ["T9 R10 config round-trip defaults", t9],
  ["T10 naming call contract (registry path)", t10],
  ["T11 provider-extension api id (cliproxyapi-style) names via registry", t11],
  ["T12 nonblocking: automatic handlers return while the title is unresolved", t12],
  ["T13 single-flight: repeated events launch no duplicate request", t13],
  ["T14 session_shutdown cancels: stale success silent, no cooldown", t14],
  ["T15 branch navigation invalidates branch-bound work", t15],
  ["T16 manual rename supersedes in-flight first naming", t16],
  ["T17 mode disable cancels only the affected request", t17],
  ["T18 stale finally does not release a newer owner", t18],
  ["T19 normal message append does not stale a valid request", t19],
  ["T20 independent deadline and cancellation in generateName", t20],
  ["T21 late provider rejection is contained", t21],
  ["T22 /rename (AI) drops stale session/branch/name results", t22],
  ["T23 auto-off cancels in-flight first naming", t23],
  ["T24 explicit /rename (AI) request ownership", t24],
  ["T25 generateName releases timer/listeners on all exits", t25],
  ["T26 session replacement: stale context/error/finalizer protection", t26],
  ["T27 manual failure recovery and mode-disable independence", t27],
  ["T28 direct listener cleanup and primary cancellation isolation", t28],
  ["T29 tree navigation preserves file-wide name ownership", t29],
  ["T30 naming notifications are terminal-only", t30],
  ["T31 explicit errors still reported off-terminal; tui unchanged", t31],
  ["T32 expanded skill blocks reduced to the user's words", t32],
];

for (const [name, fn] of tests) {
  await runTest(name, fn);
}

await tick();
if (unhandledRejections.length > 0) {
  failures++;
  console.error(`  FAIL  ${unhandledRejections.length} unhandled rejection(s); first:`, unhandledRejections[0]);
}

console.log(`\n========== SUMMARY: ${passes} passed, ${failures} failed ==========`);
process.exit(failures > 0 ? 1 : 0);
