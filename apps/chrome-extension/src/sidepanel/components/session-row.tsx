import { motion } from "motion/react";
import type { HitlMode } from "@fn-browser/browser/cdp";
import type { SessionView } from "../hooks/use-sessions.js";
import { tabGroupHex } from "../lib/chrome-palette.js";
import { Badge } from "../ui/badge.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";

const POLICY_LABELS: Record<HitlMode, string> = {
  ask: "Ask",
  follow_plan: "Follow plan",
  act: "Act",
};

const POLICY_DESCRIPTIONS: Record<HitlMode, string> = {
  ask: "Prompt before every write.",
  follow_plan: "Auto-allow non-destructive; destructive still prompts. (Act semantics today.)",
  act: "Auto-allow non-destructive; destructive still prompts.",
};

export function SessionRow({
  session,
  onPolicyChange,
  globalOverride,
}: {
  session: SessionView;
  onPolicyChange: (policy: HitlMode) => void;
  globalOverride?: HitlMode | null;
}): React.JSX.Element {
  const overridden = !!globalOverride;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-[color-mix(in_oklab,var(--muted),transparent_60%)]"
    >
      <span
        className="inline-block size-2.5 flex-shrink-0 rounded-full ring-1 ring-inset ring-black/5"
        style={{ backgroundColor: tabGroupHex(session.color) }}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-[var(--foreground)]">
            {session.name}
          </span>
          {session.workflowRunIds.length > 0 ? (
            <Badge variant="primary">{session.workflowRunIds.length} run</Badge>
          ) : null}
        </div>
        <span className="truncate text-[10.5px] text-[var(--muted-foreground)]">
          {session.ownedTabCount} tab{session.ownedTabCount === 1 ? "" : "s"}
          {session.windowId !== null ? ` · window ${session.windowId}` : ""}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={overridden ? "opacity-50" : undefined}>
            <Select
              value={session.policy}
              onValueChange={(v) => onPolicyChange(v as HitlMode)}
              disabled={overridden}
            >
              <SelectTrigger className="w-[108px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">{POLICY_LABELS.ask}</SelectItem>
                <SelectItem value="follow_plan">{POLICY_LABELS.follow_plan}</SelectItem>
                <SelectItem value="act">{POLICY_LABELS.act}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">
          {overridden
            ? `Global override active: ${POLICY_LABELS[globalOverride as HitlMode]}. Clear it in the top toggle to use per-session policy.`
            : POLICY_DESCRIPTIONS[session.policy]}
        </TooltipContent>
      </Tooltip>
    </motion.div>
  );
}
