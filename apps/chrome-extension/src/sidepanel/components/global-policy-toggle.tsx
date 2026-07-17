import { Bell, ShieldCheck, Zap } from "lucide-react";
import type { HitlMode } from "@fntune/browser/cdp";
import type { GlobalPolicy } from "../hooks/use-global-policy.js";
import { cn } from "../lib/cn.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";

const OPTIONS: Array<{
  value: GlobalPolicy;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: null,
    label: "Per-session",
    hint: "Respect each session's own policy dropdown.",
    icon: Bell,
  },
  {
    value: "ask",
    label: "Ask",
    hint: "Force a prompt before every write, overriding per-session settings.",
    icon: ShieldCheck,
  },
  {
    value: "act",
    label: "Allow all",
    hint: "Auto-allow non-destructive writes across every session. Destructive actions still prompt.",
    icon: Zap,
  },
];

export function GlobalPolicyToggle({
  value,
  onChange,
}: {
  value: GlobalPolicy;
  onChange: (next: GlobalPolicy) => void;
}): React.JSX.Element {
  const active: GlobalPolicy = value;
  return (
    <div className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)] p-0.5">
      {OPTIONS.map((opt) => {
        const isActive = active === opt.value;
        const Icon = opt.icon;
        const key = opt.value ?? "null";
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(opt.value)}
                aria-pressed={isActive}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-[11px] font-medium transition-colors",
                  isActive
                    ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                <Icon className="size-3" />
                {opt.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{opt.hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function globalPolicyBadgeText(value: GlobalPolicy): string | null {
  if (value === null) return null;
  if (value === "ask") return "Global: Ask";
  return "Global: Allow";
}

// Exported for use in session-row.tsx to indicate per-session dropdown is
// overridden by the global policy.
export function effectivePolicyFor(
  sessionPolicy: HitlMode,
  globalPolicy: GlobalPolicy,
): HitlMode {
  return globalPolicy ?? sessionPolicy;
}
