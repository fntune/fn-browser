import { Trash2, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button.js";
import { EmptyState } from "./empty-state.js";

function displayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function TrustedSitesList({
  origins,
  onRemove,
}: {
  origins: string[];
  onRemove: (origin: string) => void;
}): React.JSX.Element {
  if (origins.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No trusted sites"
        description="Click 'Always allow on <site>' on a consent prompt to trust an origin. Consent skips the modal for listed origins."
      />
    );
  }

  return (
    <div className="flex flex-col divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
      {origins.map((origin) => (
        <div
          key={origin}
          className="flex items-center justify-between gap-2 px-3 py-2"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-[12px] text-[var(--foreground)]">
              {displayHost(origin)}
            </span>
            <span className="truncate text-[10.5px] text-[var(--muted-foreground)]">
              {origin}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(origin)}
            aria-label={`Remove ${origin}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
