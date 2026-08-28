// Mock for @earendil-works/pi-ai/compat — delegates to the harness controller
// installed on globalThis.__ARN__. Records every call for assertions.
export function complete(model, context, options) {
  const ctrl = globalThis.__ARN__;
  if (!ctrl || typeof ctrl.complete !== "function") {
    return Promise.reject(new Error("harness: complete() not configured (set globalThis.__ARN__.complete)"));
  }
  ctrl.completeCalls.push({ model, context, options });
  return ctrl.complete(model, context, options);
}
export function completeSimple() {
  throw new Error("harness: completeSimple not implemented");
}
