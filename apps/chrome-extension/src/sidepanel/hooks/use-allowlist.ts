/**
 * Hook exposing the per-origin allowlist + add/remove actions. Backed by
 * chrome.storage.local on the SW side; this hook listens to the
 * `allowlist:update` port broadcast and sends `allowlist:add` /
 * `allowlist:remove` back.
 */

import { useEffect, useState } from "react";
import type { SidepanelPort } from "../port.js";

export function useAllowlist(port: SidepanelPort): {
  origins: string[];
  add: (origin: string) => void;
  remove: (origin: string) => void;
} {
  const [origins, setOrigins] = useState<string[]>([]);

  useEffect(() => {
    return port.onMessage((msg) => {
      if (msg.topic === "allowlist:update") {
        setOrigins(msg.origins);
      }
    });
  }, [port]);

  return {
    origins,
    add: (origin) => port.send({ topic: "allowlist:add", origin }),
    remove: (origin) => port.send({ topic: "allowlist:remove", origin }),
  };
}
