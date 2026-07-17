import type { RateCounterView } from "../hooks/use-rate-limits.js";
import { cn } from "../lib/cn.js";

/**
 * Simple row showing "tag : count" + relative reset time. No max available
 * from the snapshot endpoint (only consumers know their cap), so we render a
 * muted count rather than a progress fill.
 */
export function RateLimitsList({
  counters,
}: {
  counters: RateCounterView[];
}): React.JSX.Element | null {
  if (counters.length === 0) return null;
  return (
    <div className="space-y-1">
      {counters.map((c) => (
        <div
          key={c.tag}
          className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-[color-mix(in_oklab,var(--muted),transparent_60%)]"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11.5px] text-[var(--foreground)]">
              {c.tag}
            </div>
            <div className="text-[10.5px] text-[var(--muted-foreground)]">
              resets {formatRelative(c.reset_at)}
            </div>
          </div>
          <span
            className={cn(
              "ml-3 rounded-sm bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
              c.count > 0 ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
            )}
          >
            {c.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}
