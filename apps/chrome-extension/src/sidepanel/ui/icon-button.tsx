/**
 * Circular outline icon button — HoloTab-style top-bar control. Use for
 * header actions (settings, theme, help) where text would be redundant.
 * Pair with a Tooltip for discoverability.
 */

import * as React from "react";
import { cn } from "../lib/cn.js";

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, active = false, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted-foreground)] transition-colors",
        "hover:border-[var(--chrome-accent)] hover:text-[var(--foreground)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
        "[&_svg]:size-3.5",
        active && "border-[var(--chrome-accent)] text-[var(--foreground)] bg-[var(--secondary)]",
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";
