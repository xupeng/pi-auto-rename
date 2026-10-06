// Guard shim for @earendil-works/pi-ai/compat.
//
// pi-auto-rename must NOT call compat's complete(): it dispatches on pi-ai's
// global api registry, which only knows builtin api ids, so any model whose api
// id is registered by a provider extension (e.g. cliproxyapi-codex-responses)
// throws "No API provider registered for api: ...". The naming call goes through
// the mock ctx.modelRegistry.complete() in run-tests.mjs instead.
//
// Record the call for assertions, then fail loudly so a regression is visible.
export function complete(model, _context, _options) {
  const ctrl = (globalThis.__ARN__ ??= {});
  (ctrl.compatCalls ??= []).push({ model });
  throw new Error(
    "harness: naming must use ctx.modelRegistry.complete, not @earendil-works/pi-ai/compat (no API provider registered for extension-registered api ids)",
  );
}
export function completeSimple() {
  throw new Error("harness: completeSimple must not be used");
}
