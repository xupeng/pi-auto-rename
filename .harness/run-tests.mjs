/**
 * Offline verification harness for pi-auto-rename.
 *
 * - Faux provider registry + controllable API-key policy (no real network).
 * - Controllable clock (Date.now patched) and fake timers (setTimeout captured)
 *   so the 5-min thresholds and the 30s naming timeout are fully deterministic.
 * - Mock `complete` via the @earendil-works/pi-ai/compat shim in
 *   .harness/shim/pi-ai (resolved through node_modules symlink at repo root).
 *
 * Setup (once): bash .harness/setup.sh  (creates node_modules shims)
 * Run: HOME=/tmp/pi-arn-test-home node .harness/run-tests.mjs
 * Typecheck: cd .harness && npx --yes -p typescript@5.9.2 tsc -p tsconfig.check.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setImmediate as _setImmediate } from "node:timers";

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

// ---------------- complete() controller (used by the shim) ----------------
globalThis.__ARN__ = { completeCalls: [] };

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

// ---------------- faux provider registry ----------------
const MODELS = {
  faux: {
    "model-a": { provider: "faux", id: "model-a", label: "Faux A" },
    "model-b": { provider: "faux", id: "model-b", label: "Faux B" },
  },
  nokey: {
    "model-b": { provider: "nokey", id: "model-b", label: "NoKey B" },
  },
};
let KEY_POLICY = {
  faux: { ok: true, apiKey: "test-key", headers: { "X-Test": "1" } },
  nokey: { ok: false, error: "no api key configured" },
};
function resetKeyPolicy() {
  KEY_POLICY = {
    faux: { ok: true, apiKey: "test-key", headers: { "X-Test": "1" } },
    nokey: { ok: false, error: "no api key configured" },
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
    hasUI: opts.hasUI ?? true,
    signal: opts.signal, // undefined -> naming.ts own AbortController fallback
    modelRegistry: {
      find: (provider, id) => MODELS[provider]?.[id] ?? null,
      getAvailable: () => Object.values(MODELS).flatMap((m) => Object.values(m)),
      getApiKeyAndHeaders: async (model) =>
        KEY_POLICY[model.provider] ?? { ok: true, apiKey: "default-key", headers: {} },
    },
    ui: {
      notify: (message, level) => pi.notifications.push({ message, level }),
      select: async () => opts.selectResult ?? null,
    },
    sessionManager: { getBranch: () => pi.entries },
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
  clock.now = 1_700_000_000_000;
  resetKeyPolicy();
  writeConfig({ autoRename: true, continuousRename: false, style: "concise", language: "auto" });
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
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

  // First failure: getAuth fails before complete is ever called
  pushMessages(pi, ["q1", "q2", "q3"]);
  await fire(pi, "message_end");
  await tick();
  assertEq(globalThis.__ARN__.completeCalls.length, 0, "T2 failure happened before complete (auth stage)");
  let warnings = pi.notifications.filter((n) => n.level === "warning");
  assertEq(warnings.length, 1, "T2 exactly 1 warning after first failure");
  assert(warnings[0]?.message.includes("Auto rename skipped"), "T2 warning is 'Auto rename skipped'");

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
// T10 — complete() contract: apiKey/headers/maxTokens/signal forwarded
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
  assertEq(call.options.apiKey, "test-key", "T10 apiKey forwarded");
  assertEq(call.options.headers["X-Test"], "1", "T10 headers forwarded");
  assertEq(call.options.maxTokens, 64, "T10 maxTokens = 64");
  assert(!!call.options.signal, "T10 abort signal forwarded");
  assertEq(call.model.provider, "faux", "T10 default naming model follows session model (faux)");
  assertEq(call.model.id, "model-a", "T10 session model id used");
  const sys = call.context.systemPrompt;
  assert(sys.includes("You create short, descriptive titles"), "T10 system prompt passed");
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
  ["T10 complete() contract", t10],
];

for (const [name, fn] of tests) {
  await runTest(name, fn);
}

console.log(`\n========== SUMMARY: ${passes} passed, ${failures} failed ==========`);
process.exit(failures > 0 ? 1 : 0);
