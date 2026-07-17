import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[var(--border)] bg-[color-mix(in_oklab,var(--muted),transparent_60%)] px-4 py-8 text-center",
        className,
      )}
    >
      <Icon className="size-8 text-[var(--muted-foreground)]" strokeWidth={1.25} />
      <div className="text-[12.5px] font-medium text-[var(--foreground)]">{title}</div>
      {description ? (
        <div className="max-w-[220px] text-[11.5px] leading-tight text-[var(--muted-foreground)]">
          {description}
        </div>
      ) : null}
    </div>
  );
}
