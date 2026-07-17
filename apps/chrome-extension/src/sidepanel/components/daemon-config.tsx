import { useEffect, useState } from "react";

import type { DaemonConfig } from "../hooks/use-daemon-config.js";
import { Button } from "../ui/button.js";

const MODE_LABEL: Record<DaemonConfig["mode"], string> = {
  auto: "Auto-detect (local)",
  ws: "WebSocket (explicit)",
  shim: "Native shim (forced)",
};

const INPUT_CLASS =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 font-mono text-[11px] text-[var(--foreground)] outline-none focus:border-[var(--chrome-accent)]";

/**
 * Daemon connection settings. Local use needs nothing (auto-detect); a
 * remote/tailnet daemon's URL + token can't be probed, so set them here instead
 * of pasting into the service-worker console. Saving reloads the extension.
 */
export function DaemonConfigForm({
  config,
  onSet,
  onReset,
}: {
  config: DaemonConfig | null;
  onSet: (url: string, token: string) => void;
  onReset: () => void;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  // Seed the URL field from the resolved config once it arrives.
  useEffect(() => {
    setUrl(config?.url ?? "");
  }, [config?.url]);

  const trimmed = url.trim();
  const dirty = config != null && (trimmed !== config.url || token.length > 0);
  const canSave = trimmed.length > 0 && dirty;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-[var(--muted-foreground)]">
        Mode: {config ? MODE_LABEL[config.mode] : "…"}
      </div>
      <input
        type="text"
        inputMode="url"
        aria-label="Daemon WebSocket URL"
        placeholder="ws://host:7722/ws/extension"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className={INPUT_CLASS}
      />
      <input
        type="password"
        aria-label="Daemon token"
        placeholder={config?.hasToken ? "token set — blank keeps it" : "token (remote only)"}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className={INPUT_CLASS}
      />
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" disabled={!canSave} onClick={() => onSet(trimmed, token)}>
          Save &amp; reload
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={config?.mode === "auto"}
          onClick={onReset}
        >
          Auto-detect
        </Button>
      </div>
      <p className="text-[10.5px] leading-snug text-[var(--muted-foreground)]">
        Empty = auto-detect a local daemon. Set a URL for a remote/tailnet one. Saving reloads the extension.
      </p>
    </div>
  );
}
