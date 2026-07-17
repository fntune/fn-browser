/**
 * "Try asking…"-style suggestion pills shown in the empty state. Each pill
 * is a rounded-full outline button; action is optional (falsy → non-clickable
 * hint, mostly for documentation links).
 */

import { Rocket, Settings2, Scroll, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface SuggestionPillConfig {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
}

export function SuggestionPill({
  icon: Icon,
  label,
  onClick,
  href,
}: SuggestionPillConfig): React.JSX.Element {
  const className = cn(
    "inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-transparent px-3.5 py-1.5 text-[12px] text-[var(--muted-foreground)] transition-colors",
    "hover:border-[var(--chrome-accent)] hover:text-[var(--foreground)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
  );
  const inner = (
    <>
      <Icon className="size-3.5" />
      <span>{label}</span>
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {inner}
    </button>
  );
}

export function SuggestionPills({
  items,
}: {
  items: SuggestionPillConfig[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2">
      {items.map((p) => (
        <SuggestionPill key={p.label} {...p} />
      ))}
    </div>
  );
}

export { Rocket, Settings2, Scroll };
