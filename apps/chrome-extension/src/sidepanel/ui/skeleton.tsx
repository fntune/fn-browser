// shadcn@2026-04 — Skeleton
import * as React from "react";
import { cn } from "../lib/cn.js";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[color-mix(in_oklab,var(--muted),transparent_30%)]",
        className,
      )}
      {...props}
    />
  );
}
