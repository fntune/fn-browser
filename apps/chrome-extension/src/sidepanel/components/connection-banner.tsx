import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CircleDot } from "lucide-react";
import { cn } from "../lib/cn.js";
import type { HostStatus } from "../hooks/use-host-status.js";

export function ConnectionBanner({ status }: { status: HostStatus }): React.JSX.Element {
  const portDead = !status.portConnected;
  const hostDead = status.portConnected && !status.connected;
  const anyError = portDead || hostDead;

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--background)]">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            anyError ? "bg-[var(--destructive)]" : "bg-[var(--success)]",
          )}
          aria-hidden
        />
        <span className="text-[12px] font-medium text-[var(--foreground)]">fn-browser</span>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          {portDead
            ? "service worker offline"
            : hostDead
              ? "native host offline"
              : `connected · ${status.attachedTabs} attached`}
        </span>
      </div>

      <AnimatePresence>
        {anyError ? (
          <motion.div
            key="banner"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px]",
              "bg-[color-mix(in_oklab,var(--destructive),transparent_85%)] text-[var(--destructive)]",
            )}
          >
            <AlertTriangle className="size-3" />
            {portDead ? "retrying…" : "waiting for host"}
          </motion.div>
        ) : (
          <motion.span
            key="ok"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="flex items-center gap-1 text-[10.5px] text-[var(--muted-foreground)]"
          >
            <CircleDot className="size-3" />
            live
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
