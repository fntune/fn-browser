/**
 * Hook exposing the daemon transport config + edit actions. Backed by
 * chrome.storage.local on the SW side; this hook listens to the `daemon:config`
 * broadcast and sends `daemon:set` / `daemon:reset` back. The SW reloads the
 * extension after a set/reset so the new transport is selected on boot.
 */

import { useEffect, useState } from "react";
import type { DaemonMode } from "../../shared/protocol.js";
import type { SidepanelPort } from "../port.js";

export interface DaemonConfig {
  mode: DaemonMode;
  url: string;
  hasToken: boolean;
}

export function useDaemonConfig(port: SidepanelPort): {
  config: DaemonConfig | null;
  set: (url: string, token: string) => void;
  reset: () => void;
} {
  const [config, setConfig] = useState<DaemonConfig | null>(null);

  useEffect(() => {
    return port.onMessage((msg) => {
      if (msg.topic === "daemon:config") {
        setConfig({ mode: msg.mode, url: msg.url, hasToken: msg.hasToken });
      }
    });
  }, [port]);

  return {
    config,
    set: (url, token) => port.send({ topic: "daemon:set", url, token }),
    reset: () => port.send({ topic: "daemon:reset" }),
  };
}
