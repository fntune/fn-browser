/**
 * Runtime.evaluate — runs JS in the page context and returns a JSON value.
 *
 * We do NOT call Runtime.enable — that leaks executionContextIds. Runtime.evaluate
 * works without enable; Chrome's CDP creates an ad-hoc execution context for
 * the call and doesn't persist or advertise it. This is distinct from the
 * Runtime domain "listening for execution contexts" which is what detectors
 * probe for.
 *
 * Destructive flag threads through to the command-router, which should gate
 * on consent at a higher layer before calling this primitive.
 */

import { attachIfNeeded } from "./attach.js";
import { send } from "./send.js";
import { browserError, type EvaluateJsArgs } from "./types.js";

export interface EvaluateJsResult<T = unknown> {
  ok: true;
  value: T;
}

interface RuntimeEvaluateResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    exceptionId: number;
    text: string;
    lineNumber: number;
    columnNumber: number;
    exception?: { description?: string };
  };
}

export async function evaluateJs<T = unknown>(
  args: EvaluateJsArgs,
): Promise<EvaluateJsResult<T>> {
  await attachIfNeeded(args.tabId);

  const result = await send<RuntimeEvaluateResult>(args.tabId, "Runtime.evaluate", {
    expression: args.expression,
    returnByValue: true,
    awaitPromise: args.awaitPromise ?? true,
  });

  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text;
    const err = browserError("cdp_error", {
      cdpCode: 0,
      cdpMessage: desc,
      message: `evaluate_js threw: ${desc}`,
    });
    const e = new Error(err.message);
    (e as Error & { browserError: typeof err }).browserError = err;
    throw e;
  }

  return {
    ok: true,
    value: (result.result.value ?? null) as T,
  };
}
