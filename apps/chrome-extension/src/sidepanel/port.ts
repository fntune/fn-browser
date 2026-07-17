/**
 * Typed wrapper around chrome.runtime.connect({name:"sidepanel"}) with
 * auto-reconnect and late-subscriber replay.
 *
 * `openSidepanelPort()` runs at module load, which is before React mounts and
 * subscribes. The first connect + message(s) can fire before subscription, so
 * we cache the current connection state and the last message per topic; new
 * subscribers get an immediate replay.
 *
 * Reconnect is critical because MV3 service workers can die when idle. When
 * the SW wakes on a native-port reconnect, the panel's existing port is dead
 * and Chrome emits an `onDisconnect`. We retry with exponential backoff.
 */

import {
  SIDEPANEL_PORT_NAME,
  type PanelToSwMessage,
  type SwToPanelMessage,
} from "../shared/protocol.js";

type MessageHandler = (msg: SwToPanelMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

export interface SidepanelPort {
  send(msg: PanelToSwMessage): void;
  onMessage(handler: MessageHandler): () => void;
  onConnection(handler: ConnectionHandler): () => void;
  close(): void;
}

export function openSidepanelPort(): SidepanelPort {
  let port: chrome.runtime.Port | undefined;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = 250;

  let currentConnection = false;
  const lastMessageByTopic = new Map<SwToPanelMessage["topic"], SwToPanelMessage>();

  const messageHandlers = new Set<MessageHandler>();
  const connectionHandlers = new Set<ConnectionHandler>();

  function setConnection(connected: boolean): void {
    currentConnection = connected;
    for (const h of connectionHandlers) {
      try {
        h(connected);
      } catch (err) {
        console.error("[sidepanel] connection handler threw:", err);
      }
    }
  }

  function dispatchMessage(msg: SwToPanelMessage): void {
    lastMessageByTopic.set(msg.topic, msg);
    for (const h of messageHandlers) {
      try {
        h(msg);
      } catch (err) {
        console.error("[sidepanel] message handler threw:", err);
      }
    }
  }

  function connect(): void {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: SIDEPANEL_PORT_NAME });
    } catch (err) {
      console.warn("[sidepanel] connect failed, will retry:", err);
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener((raw) => {
      dispatchMessage(raw as SwToPanelMessage);
    });

    port.onDisconnect.addListener(() => {
      setConnection(false);
      port = undefined;
      scheduleReconnect();
    });

    backoffMs = 250;
    setConnection(true);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, backoffMs);
    // Exponential backoff capped at 5s.
    backoffMs = Math.min(backoffMs * 2, 5000);
  }

  connect();

  return {
    send(msg) {
      if (!port) {
        console.warn("[sidepanel] send skipped — port not connected:", msg);
        return;
      }
      try {
        port.postMessage(msg);
      } catch (err) {
        console.warn("[sidepanel] postMessage failed:", err);
      }
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      // Replay last message per topic so late subscribers see the current
      // state (SW pushes a `host:status` + `consent:update` on each connect,
      // but React's useEffect runs after the port was opened at module load).
      for (const cached of lastMessageByTopic.values()) {
        try {
          handler(cached);
        } catch (err) {
          console.error("[sidepanel] replay to late subscriber threw:", err);
        }
      }
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onConnection(handler) {
      connectionHandlers.add(handler);
      // Immediate replay of the current connection state — same rationale as
      // onMessage above.
      try {
        handler(currentConnection);
      } catch (err) {
        console.error("[sidepanel] replay to late connection subscriber threw:", err);
      }
      return () => {
        connectionHandlers.delete(handler);
      };
    },
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      try {
        port?.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
