// shadcn@2026-04 — Badge
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        primary:
          "bg-[color-mix(in_oklab,var(--primary),transparent_80%)] text-[var(--primary)]",
        success:
          "bg-[color-mix(in_oklab,var(--success),transparent_80%)] text-[var(--success)]",
        warning:
          "bg-[color-mix(in_oklab,var(--warning),transparent_80%)] text-[var(--warning)]",
        destructive:
          "bg-[color-mix(in_oklab,var(--destructive),transparent_80%)] text-[var(--destructive)]",
        outline:
          "border border-[var(--border)] text-[var(--foreground)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
