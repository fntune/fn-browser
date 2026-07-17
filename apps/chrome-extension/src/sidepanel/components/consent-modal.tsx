import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert } from "lucide-react";
import { Button } from "../ui/button.js";
import type { ConsentRequestSnapshot } from "../../shared/protocol.js";

function displayOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function ConsentStack({
  pending,
  onResolve,
  onAlwaysAllow,
  focusedIndex,
}: {
  pending: ConsentRequestSnapshot[];
  onResolve: (id: string, choice: string) => void;
  onAlwaysAllow: (id: string, origin: string) => void;
  focusedIndex: number;
}): React.JSX.Element | null {
  if (pending.length === 0) return null;

  // Render the top item only — others are summarized underneath.
  const [top, ...rest] = pending;
  if (!top) return null;

  const host = displayOrigin(top.origin);

  return (
    <section
      className="pointer-events-auto"
      aria-label="Pending consent requests"
      aria-live="polite"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={top.id}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ type: "spring", stiffness: 320, damping: 28 }}
          className="rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)] shadow-lg"
        >
          <div className="flex items-start gap-2.5 p-4">
            <div className="mt-0.5 rounded-md bg-[color-mix(in_oklab,var(--primary),transparent_85%)] p-1.5 text-[var(--primary)]">
              <ShieldAlert className="size-3.5" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="truncate text-[13px] font-semibold tracking-tight">
                {top.title}
              </div>
              {host ? (
                <div className="truncate font-mono text-[10.5px] text-[var(--muted-foreground)]">
                  {host}
                </div>
              ) : null}
              <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-[var(--muted-foreground)]">
                {top.body}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t border-[var(--border)] px-4 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10.5px] text-[var(--muted-foreground)]">
                {rest.length > 0
                  ? `+${rest.length} more pending`
                  : `focused ${focusedIndex + 1}/${pending.length}`}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onResolve(top.id, "deny")}>
                  Deny
                </Button>
                <Button size="sm" onClick={() => onResolve(top.id, "allow")}>
                  Allow
                </Button>
              </div>
            </div>
            {top.origin ? (
              <Button
                variant="outline"
                size="sm"
                className="self-end text-[11px]"
                onClick={() => onAlwaysAllow(top.id, top.origin as string)}
              >
                Always allow on {host}
              </Button>
            ) : null}
          </div>
        </motion.div>
      </AnimatePresence>

      {rest.length > 0 ? (
        <div className="mt-2 space-y-1 opacity-70">
          {rest.slice(0, 3).map((r) => (
            <div
              key={r.id}
              className="truncate rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[11.5px] text-[var(--muted-foreground)]"
            >
              {r.title}
            </div>
          ))}
          {rest.length > 3 ? (
            <div className="px-3 text-[10.5px] text-[var(--muted-foreground)]">
              …and {rest.length - 3} more
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
