export type {
  BrowserAction,
  ClickArgs,
  FillFormArgs,
  HitlMode,
  SessionId,
  TabId,
  TabInfo,
  UploadArgs,
} from "./cdp/types.js";
export {
  BrowserController,
  type BrowserControllerOptions,
} from "./cdp/browser-controller.js";
export { browserProxyOptionsFromEnv, createBrowserProxy } from "./mcp/proxy.js";
export type { BrowserProxyOptions, BrowserProxyHandler } from "./mcp/proxy.js";
