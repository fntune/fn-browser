import { useEffect, useState } from "react";
import type { SidepanelPort } from "../port.js";
import type { SwToPanelMessage } from "../../shared/protocol.js";

export interface HostStatus {
  connected: boolean;
  attachedTabs: number;
  portConnected: boolean;
}

export function useHostStatus(port: SidepanelPort): HostStatus {
  const [status, setStatus] = useState<HostStatus>({
    connected: false,
    attachedTabs: 0,
    portConnected: false,
  });

  useEffect(() => {
    const offMessage = port.onMessage((msg: SwToPanelMessage) => {
      if (msg.topic === "host:status") {
        setStatus((s) => ({
          ...s,
          connected: msg.connected,
          attachedTabs: msg.attachedTabs,
        }));
      }
    });
    const offConnection = port.onConnection((portConnected) => {
      setStatus((s) =>
        portConnected ? { ...s, portConnected } : { connected: false, attachedTabs: 0, portConnected },
      );
    });
    return () => {
      offMessage();
      offConnection();
    };
  }, [port]);

  return status;
}
