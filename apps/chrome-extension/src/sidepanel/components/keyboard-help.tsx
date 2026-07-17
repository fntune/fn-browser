import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "⌘⇧A", description: "Allow all pending consents" },
  { keys: "⌘⇧D", description: "Deny all pending consents" },
  { keys: "⌘↓ / ⌘↑", description: "Navigate between pending items" },
  { keys: "?", description: "Show this help" },
];

export function KeyboardHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Global shortcuts available anywhere in the side panel.
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 space-y-1.5">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-[12px]"
            >
              <span className="text-[var(--muted-foreground)]">{s.description}</span>
              <kbd className="rounded-sm border border-[var(--border)] bg-[var(--secondary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--foreground)]">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
