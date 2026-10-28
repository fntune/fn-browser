/**
 * Side-effect module: redirect console.log/info/debug to stderr before any
 * other import runs. Native-messaging hosts own stdout for Chrome's binary
 * protocol — any text written there corrupts frames and Chrome disconnects
 * the port, killing the host. `@fn-browser/log`'s default `info`/`log` path uses
 * console.log, so we rebind those globally in this process.
 *
 * Import this FIRST in main.ts. ESM import order is deterministic: this
 * module's top-level runs before subsequent imports initialize, so any
 * downstream code that captures a reference to `console.log` gets the
 * stderr-bound variant.
 */

console.log = console.error;
console.info = console.error;
console.debug = console.error;
