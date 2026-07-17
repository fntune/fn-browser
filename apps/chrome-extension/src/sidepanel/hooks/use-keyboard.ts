import { useEffect } from "react";

export interface KeyboardActions {
  allowAll: () => void;
  denyAll: () => void;
  nextItem: () => void;
  prevItem: () => void;
  openHelp: () => void;
}

/**
 * Global shortcuts:
 *   ⌘⇧A  allow all pending consents
 *   ⌘⇧D  deny all pending consents
 *   ⌘↓ / ⌘↑  move focus between pending items
 *   ?    toggle shortcut help
 */
export function useGlobalKeyboard(actions: KeyboardActions): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        actions.allowAll();
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        actions.denyAll();
        return;
      }
      if (mod && e.code === "ArrowDown") {
        e.preventDefault();
        actions.nextItem();
        return;
      }
      if (mod && e.code === "ArrowUp") {
        e.preventDefault();
        actions.prevItem();
        return;
      }
      if (!typing && !mod && e.key === "?") {
        e.preventDefault();
        actions.openHelp();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);
}
