import { useCallback, useEffect, useState } from "react";
import type { SidepanelPort } from "../port.js";
import type { ConsentRequestSnapshot, SwToPanelMessage } from "../../shared/protocol.js";

export function useConsentQueue(port: SidepanelPort): {
  pending: ConsentRequestSnapshot[];
  resolve: (id: string, choice: string) => void;
} {
  const [pending, setPending] = useState<ConsentRequestSnapshot[]>([]);

  useEffect(() => {
    return port.onMessage((msg: SwToPanelMessage) => {
      if (msg.topic === "consent:update") {
        setPending(msg.pending);
      }
    });
  }, [port]);

  const resolve = useCallback(
    (id: string, choice: string) => {
      port.send({ topic: "consent:resolve", id, choice });
      // Optimistic: remove from local state immediately. Next broadcast
      // confirms.
      setPending((current) => current.filter((r) => r.id !== id));
    },
    [port],
  );

  return { pending, resolve };
}
