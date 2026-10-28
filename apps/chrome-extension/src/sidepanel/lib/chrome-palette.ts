/**
 * Chrome tab-group color → hex lookup. Matches the palette Chrome renders in
 * the tab strip so the side-panel chips feel consistent with what the user
 * sees outside the extension.
 */

import type { ChromeTabGroupColor } from "@fn-browser/browser/cdp";

export const CHROME_TAB_GROUP_HEX: Record<ChromeTabGroupColor, string> = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#1e8e3e",
  pink: "#e91e63",
  purple: "#9334e6",
  cyan: "#02afa3",
  orange: "#f29900",
};

export function tabGroupHex(color: ChromeTabGroupColor | string | undefined): string {
  if (!color) return CHROME_TAB_GROUP_HEX.grey;
  return CHROME_TAB_GROUP_HEX[color as ChromeTabGroupColor] ?? CHROME_TAB_GROUP_HEX.grey;
}
