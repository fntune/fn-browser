import { Browsers } from "../browsers.js";
import type { ExtensionBridge } from "../extension-bridge.js";

/** Registry holding stub bridges as already-connected browsers (no hello handshake). */
export function browsersOf(...bridges: ExtensionBridge[]): Browsers {
  const browsers = new Browsers();
  for (const bridge of bridges) browsers.add(bridge);
  return browsers;
}
