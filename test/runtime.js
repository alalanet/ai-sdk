// Runs fn with globalThis.process hidden (and other globals set), as code runs in a browser, then puts them back.
// Only the synchronous part of fn sees the change: the package decides about its runtime before its first await.
export function asRuntime(globals, fn) {
  const saved = {};
  const keys = ["process", ...Object.keys(globals)];
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}
