/**
 * Accessibility-tree grounding. Returns compact ref handles (not the full tree)
 * matched against a natural-language query.
 *
 * Implementation strategy:
 *   1. Accessibility.getFullAXTree grabs all a11y nodes on the tab.
 *   2. Filter to interactive/focusable nodes (buttons, links, inputs, textboxes,
 *      comboboxes, etc.) plus nodes with a non-empty `name` matching the query.
 *   3. Return an array of refs { ref, role, name, description?, selector? }.
 *
 * ref handles are opaque strings we mint: "ax-<backendNodeId>". Callers pass
 * them to subsequent click/fill_form/upload_file calls.
 */

import { attachIfNeeded } from "./attach.js";
import { send } from "./send.js";
import type { ObserveArgs, ObserveResult } from "./types.js";

interface AxValue<T = unknown> {
  type: string;
  value?: T;
}

interface AxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: AxValue<string>;
  name?: AxValue<string>;
  description?: AxValue<string>;
  ignored: boolean;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "listbox",
  "menuitem",
  "tab",
  "switch",
  "searchbox",
  "spinbutton",
  "slider",
  "option",
]);

export async function observe(args: ObserveArgs): Promise<ObserveResult> {
  await attachIfNeeded(args.tabId);
  const { nodes } = await send<{ nodes: AxNode[] }>(
    args.tabId,
    "Accessibility.getFullAXTree",
    {},
  );

  const scope = args.scope ?? "interactive";
  const queryLower = args.query.toLowerCase().trim();

  const candidates = nodes.filter((n) => {
    if (n.ignored) return false;
    if (n.backendDOMNodeId === undefined) return false;
    const role = n.role?.value;
    if (scope === "interactive" && (!role || !INTERACTIVE_ROLES.has(role))) {
      return false;
    }
    if (!queryLower) return true;
    const name = (n.name?.value ?? "").toLowerCase();
    const desc = (n.description?.value ?? "").toLowerCase();
    return name.includes(queryLower) || desc.includes(queryLower);
  });

  const refs = candidates.slice(0, 50).map((n) => ({
    ref: `ax-${n.backendDOMNodeId}`,
    role: n.role?.value ?? "",
    name: n.name?.value ?? "",
    description: n.description?.value,
  }));

  return { refs };
}

/**
 * Resolve an opaque ref handle back to a CDP backendNodeId usable with
 * DOM.setFileInputFiles etc.
 */
export function refToBackendNodeId(ref: string): number | undefined {
  if (!ref.startsWith("ax-")) return undefined;
  const n = Number(ref.slice(3));
  return Number.isFinite(n) ? n : undefined;
}
