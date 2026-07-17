import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Inbox,
  Keyboard,
  Layers,
  Moon,
  Rocket,
  Scroll,
  Settings,
  Settings2,
  ShieldCheck,
  Sun,
  SunMoon,
} from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";

import { openSidepanelPort } from "./port.js";
import { useAllowlist } from "./hooks/use-allowlist.js";
import { useDaemonConfig } from "./hooks/use-daemon-config.js";
import { useConsentQueue } from "./hooks/use-consent-queue.js";
import { useGlobalPolicy } from "./hooks/use-global-policy.js";
import { useHostStatus } from "./hooks/use-host-status.js";
import { useRateLimits } from "./hooks/use-rate-limits.js";
import { useSessions } from "./hooks/use-sessions.js";
import { useTheme } from "./hooks/use-theme.js";
import { useGlobalKeyboard } from "./hooks/use-keyboard.js";

import { ConnectionBanner } from "./components/connection-banner.js";
import { ConsentStack } from "./components/consent-modal.js";
import { EmptyState } from "./components/empty-state.js";
import { DaemonConfigForm } from "./components/daemon-config.js";
import { GlobalPolicyToggle } from "./components/global-policy-toggle.js";
import { KeyboardHelp } from "./components/keyboard-help.js";
import { RateLimitsList } from "./components/rate-limits.js";
import { SessionRow } from "./components/session-row.js";
import { SuggestionPills } from "./components/suggestion-pills.js";
import { TrustedSitesList } from "./components/trusted-sites.js";

import { IconButton } from "./ui/icon-button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

import { TooltipProvider } from "./ui/tooltip.js";
// Separator + Skeleton stay imported via their respective components; the
// refreshed app shell no longer uses them directly.
import { Separator } from "./ui/separator.js";
import { Skeleton } from "./ui/skeleton.js";

// One port for the app lifetime. Capture outside React so a single instance is
// reused across re-renders; tests can ignore since we don't import app.tsx.
const port = openSidepanelPort();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnMount: true,
    },
  },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <AppInner />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function AppInner(): React.JSX.Element {
  const theme = useTheme();
  const status = useHostStatus(port);
  const { pending, resolve } = useConsentQueue(port);
  const { sessions, isLoading: sessionsLoading, isError: sessionsError } = useSessions();
  const { setPolicy } = useSessions();
  const { counters } = useRateLimits();
  const { policy: globalPolicy, setPolicy: setGlobalPolicy } = useGlobalPolicy();
  const { origins: allowlist, add: addOrigin, remove: removeOrigin } =
    useAllowlist(port);
  const { config: daemonConfig, set: setDaemon, reset: resetDaemon } =
    useDaemonConfig(port);

  const handleAlwaysAllow = useCallback(
    (id: string, origin: string) => {
      addOrigin(origin);
      resolve(id, "allow");
    },
    [addOrigin, resolve],
  );

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const defaultsWrapRef = useRef<HTMLDivElement>(null);

  // Close the Defaults popover on outside click / Escape.
  useEffect(() => {
    if (!defaultsOpen) return;
    function onPointer(e: PointerEvent): void {
      if (!defaultsWrapRef.current) return;
      if (defaultsWrapRef.current.contains(e.target as Node)) return;
      setDefaultsOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setDefaultsOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [defaultsOpen]);

  // Keep focus in range when pending list shrinks.
  useEffect(() => {
    if (focusedIndex >= pending.length) setFocusedIndex(Math.max(0, pending.length - 1));
  }, [pending.length, focusedIndex]);

  const keyboardActions = useMemo(
    () => ({
      allowAll: () => {
        pending.forEach((p) => {
          resolve(p.id, "allow");
        });
      },
      denyAll: () => {
        pending.forEach((p) => {
          resolve(p.id, "deny");
        });
      },
      nextItem: () =>
        setFocusedIndex((i) => (pending.length === 0 ? 0 : (i + 1) % pending.length)),
      prevItem: () =>
        setFocusedIndex((i) =>
          pending.length === 0 ? 0 : (i - 1 + pending.length) % pending.length,
        ),
      openHelp: () => setHelpOpen(true),
    }),
    [pending, resolve],
  );
  useGlobalKeyboard(keyboardActions);

  // Stable handler for session-row policy change.
  const onPolicyChange = useCallback(
    (id: string) => (policy: Parameters<typeof setPolicy>[1]) => setPolicy(id, policy),
    [setPolicy],
  );

  return (
    <div className="flex h-screen w-full flex-col bg-[var(--background)] text-[var(--foreground)]">
      <ConnectionBanner status={status} />

      <header className="flex items-center justify-between gap-2 border-b border-[var(--chrome-frame)] px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-full bg-[var(--chrome-accent)]"
            aria-hidden
          />
          <span className="text-[13px] font-semibold tracking-tight text-[var(--foreground)]">
            fn-browser
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div ref={defaultsWrapRef} className="relative">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Defaults"
                  aria-expanded={defaultsOpen}
                  active={defaultsOpen || globalPolicy !== null}
                  onClick={() => setDefaultsOpen((v) => !v)}
                >
                  <Settings />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">Defaults</TooltipContent>
            </Tooltip>
            {defaultsOpen ? (
              <div
                role="dialog"
                className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[240px] rounded-md border border-[var(--border)] bg-[var(--popover)] p-3 text-[var(--popover-foreground)] shadow-lg"
              >
                <div className="flex flex-col gap-3">
                  <div className="text-[10.5px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                    Global mode
                  </div>
                  <GlobalPolicyToggle
                    value={globalPolicy}
                    onChange={setGlobalPolicy}
                  />
                  <p className="text-[11px] leading-snug text-[var(--muted-foreground)]">
                    Overrides per-session policy. Destructive actions always prompt.
                  </p>
                  <Separator />
                  <div className="text-[10.5px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                    Daemon connection
                  </div>
                  <DaemonConfigForm
                    config={daemonConfig}
                    onSet={setDaemon}
                    onReset={resetDaemon}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Toggle theme"
                onClick={() => theme.cycle()}
              >
                {theme.setting === "light" ? (
                  <Sun />
                ) : theme.setting === "dark" ? (
                  <Moon />
                ) : (
                  <SunMoon />
                )}
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">Theme: {theme.setting}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Keyboard shortcuts"
                onClick={() => setHelpOpen(true)}
              >
                <Keyboard />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">Shortcuts</TooltipContent>
          </Tooltip>
          <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
        {/* Pending consents — top priority */}
        {pending.length > 0 ? (
          <section>
            <SectionHeader
              icon={<ShieldCheck className="size-3" />}
              label="pending consent"
              count={pending.length}
            />
            <ConsentStack
              pending={pending}
              onResolve={resolve}
              onAlwaysAllow={handleAlwaysAllow}
              focusedIndex={focusedIndex}
            />
          </section>
        ) : null}

        {/* Sessions */}
        <section>
          <SectionHeader
            icon={<Layers className="size-3" />}
            label="sessions"
            count={sessions.length}
          />
          {sessionsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : sessionsError ? (
            <EmptyState
              icon={Inbox}
              title="Host unreachable"
              description="The fn-browser native host isn't responding on localhost:7722. Open Chrome and make sure the extension is enabled."
            />
          ) : sessions.length === 0 ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="text-[13px] font-medium text-[var(--foreground)]">
                Get started
              </div>
              <div className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                Start a session from Claude Code and it'll appear here with
                its own tab group and policy.
              </div>
              <SuggestionPills
                items={[
                  {
                    icon: Rocket,
                    label: "Start a session",
                    onClick: () => {
                      void navigator.clipboard?.writeText(
                        'mcp__fn-browser__start({ name: "my-task" })',
                      );
                    },
                  },
                  {
                    icon: Settings2,
                    label: "Configure defaults",
                    onClick: () => setHelpOpen(false),
                  },
                  {
                    icon: Scroll,
                    label: "Show run logs path",
                    onClick: () => {
                      void navigator.clipboard?.writeText("~/.fn-browser/runs");
                    },
                  },
                ]}
              />
            </div>
          ) : (
            <div className="flex flex-col">
              <AnimatePresence initial={false}>
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    onPolicyChange={onPolicyChange(s.id)}
                    globalOverride={globalPolicy}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>

        {/* Trusted sites (allowlist) — only shown when there's at least one */}
        {allowlist.length > 0 ? (
          <>
            <Separator />
            <section>
              <SectionHeader
                icon={<ShieldCheck className="size-3" />}
                label="trusted sites"
                count={allowlist.length}
              />
              <TrustedSitesList origins={allowlist} onRemove={removeOrigin} />
            </section>
          </>
        ) : null}

        {/* Rate limits */}
        {counters.length > 0 ? (
          <>
            <Separator />
            <section>
              <SectionHeader
                icon={<span aria-hidden>⟳</span>}
                label="rate limits"
                count={counters.length}
              />
              <RateLimitsList counters={counters} />
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
      <span className="flex size-3.5 items-center justify-center text-[var(--muted-foreground)]">
        {icon}
      </span>
      <span>{label}</span>
      {count > 0 ? (
        <span className="ml-1 rounded-sm bg-[var(--secondary)] px-1 font-mono text-[10px] tabular-nums text-[var(--foreground)]">
          {count}
        </span>
      ) : null}
    </div>
  );
}
