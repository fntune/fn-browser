/** Extra MCP tools registered by this host beyond the built-in catalog. */

import type { McpToolPlugin } from "@fn-browser/browser/mcp";
import type { Browsers } from "./browsers.js";

export function createHostToolPlugins(browsers: Browsers): McpToolPlugin[] {
  return [
    {
      tool: {
        name: "list_browsers",
        description:
          "List connected browsers: one per Chrome profile running the fn-browser extension. Pass an id or label as start's browser to drive that profile; default marks the one start picks when browser is omitted (the most recently focused).",
        permission: "meta",
        inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      },
      handler: async () => ({ ok: true, result: { browsers: browsers.list() } }),
    },
  ];
}
