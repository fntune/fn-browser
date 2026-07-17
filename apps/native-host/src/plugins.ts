/**
 * Extra MCP tools this host registers beyond @fntune/browser's built-in
 * catalog. Standalone fn-browser distribution: no @fntune/workflows, so no
 * run_flow — this stub is the ONLY source difference from the fntune
 * monorepo's native-host (which registers @fntune/browser-flow's plugin here).
 */

import type { McpToolPlugin } from "@fntune/browser/mcp";

export function createHostToolPlugins(): McpToolPlugin[] {
  return [];
}
