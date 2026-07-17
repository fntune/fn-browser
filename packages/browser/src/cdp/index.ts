export {
  attachIfNeeded,
  detachTab,
  isAttached,
  onDetach,
  __resetAttachStateForTests,
  type DetachHandler,
  type DetachReason,
} from "./attach.js";
export { BrowserController, type BrowserControllerOptions } from "./browser-controller.js";
export { click, type ClickResult } from "./click.js";
export { describeNode, focusNode, querySelectorNodeId } from "./dom.js";
export { evaluateJs, type EvaluateJsResult } from "./evaluate-js.js";
export { fillForm, type FillFormResult } from "./fill-form.js";
export {
  ensureLogCapture,
  readConsole,
  type ConsoleEntry,
  type ReadConsoleArgs,
} from "./log-entries.js";
export { withTabMutex, __resetMutexStateForTests } from "./mutex.js";
export { navigate, type NavigateResult } from "./navigate.js";
export {
  ensureNetworkCapture,
  readNetwork,
  type NetworkEntry,
  type ReadNetworkArgs,
} from "./network.js";
export { observe, refToBackendNodeId } from "./observe.js";
export { getPageText, readPage, type GetPageTextResult, type ReadPageArgs, type ReadPageResult } from "./read-page.js";
export { screenshot, type ScreenshotResult } from "./screenshot.js";
export { getBrowserError, send, type SendOptions } from "./send.js";
export { setFileInput, type SetFileInputResult } from "./set-file-input.js";
export {
  adoptTab,
  createTab,
  listTabs,
  type AdoptTabArgs,
  type CreateTabArgs,
  type GroupInstruction,
  type ListTabsArgs,
} from "./tabs.js";
export {
  browserError,
  type BrowserAction,
  type BrowserActionMeta,
  type BrowserError,
  type ChromeTabGroupColor,
  type ClickArgs,
  type EvaluateJsArgs,
  type FillFormArgs,
  type HitlMode,
  type NavigateArgs,
  type ObserveArgs,
  type ObserveResult,
  type RunId,
  type ScreenshotArgs,
  type SessionId,
  type TabId,
  type TabInfo,
  type UploadArgs,
} from "./types.js";
