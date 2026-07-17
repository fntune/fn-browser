/**
 * Wire protocol for messages flowing between the native host and the extension
 * background service worker, and between background <-> side panel.
 *
 * Structure: every message has an `id` (UUID) used for request/response
 * correlation, a `kind` (command or event), and a typed payload.
 *
 * The native host speaks this protocol over stdio (native messaging); the
 * extension background SW speaks it over the chrome.runtime.connectNative port.
 */

export type MessageId = string;

export interface HostToExtensionCommand {
  id: MessageId;
  kind: "command";
  method: HostCommandMethod;
  params: Record<string, unknown>;
}

export interface ExtensionToHostResponse {
  id: MessageId;
  kind: "response";
  ok: true;
  result: unknown;
}

export interface ExtensionToHostError {
  id: MessageId;
  kind: "response";
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ExtensionToHostEvent {
  id: MessageId;
  kind: "event";
  topic: ExtensionEventTopic;
  payload: Record<string, unknown>;
}

export interface HostHello {
  id: MessageId;
  kind: "hello";
  extensionVersion: string;
  protocolVersion: number;
}

export interface HostHelloAck {
  id: MessageId;
  kind: "hello_ack";
  hostVersion: string;
  protocolVersion: number;
}

/**
 * App-level liveness over the WebSocket transport. The daemon sends `ping`
 * periodically while connected; the extension answers `pong` immediately. A
 * raw WebSocket (unlike a Chrome native port) gives no signal when the daemon
 * silently wedges, so the missing pong drives reconnection.
 */
export interface HostPing {
  id: MessageId;
  kind: "ping";
}

export interface ExtensionPong {
  id: MessageId;
  kind: "pong";
}

export type HostCommandMethod =
  | "upload_file"
  | "navigate"
  | "click"
  | "fill_form"
  | "observe"
  | "screenshot"
  | "read_page"
  | "get_page_text"
  | "evaluate_js"
  | "list_tabs"
  | "create_tab"
  | "adopt_tab"
  | "detach_tab"
  | "session_start"
  | "session_end"
  | "session_info"
  | "list_sessions";

export type ExtensionEventTopic =
  | "tab_updated"
  | "tab_removed"
  | "tab_group_changed"
  | "debugger_detached"
  | "consent_requested"
  | "stop_clicked";

export type NativeMessage =
  | HostHello
  | HostHelloAck
  | HostPing
  | ExtensionPong
  | HostToExtensionCommand
  | ExtensionToHostResponse
  | ExtensionToHostError
  | ExtensionToHostEvent;

/**
 * Side panel ↔ background service worker long-lived port protocol.
 *
 * Wire: `chrome.runtime.connect({ name: "sidepanel" })`. The SW pushes state
 * updates; the panel sends user actions back.
 */
export const SIDEPANEL_PORT_NAME = "sidepanel";

export interface ConsentRequestSnapshot {
  id: string;
  title: string;
  body: string;
  options: string[];
  createdAt: number;
  /** Origin of the target page, when resolvable (e.g. `https://linkedin.com`). */
  origin?: string;
}

/** Transport mode the SW resolved at boot (see background/transport-config). */
export type DaemonMode = "auto" | "ws" | "shim";

export type SwToPanelMessage =
  | { topic: "host:status"; connected: boolean; attachedTabs: number }
  | { topic: "consent:update"; pending: ConsentRequestSnapshot[] }
  | { topic: "allowlist:update"; origins: string[] }
  // Current daemon transport config. `url` is set only in ws mode; `hasToken`
  // reports presence without ever shipping the secret to the panel.
  | { topic: "daemon:config"; mode: DaemonMode; url: string; hasToken: boolean };

export type PanelToSwMessage =
  | { topic: "consent:resolve"; id: string; choice: string }
  | { topic: "allowlist:add"; origin: string }
  | { topic: "allowlist:remove"; origin: string }
  // Set an explicit daemon URL (+ optional token) — for a remote/tailnet daemon.
  | { topic: "daemon:set"; url: string; token: string }
  // Clear the explicit config → fall back to loopback auto-detect.
  | { topic: "daemon:reset" };

export const PROTOCOL_VERSION = 1;

export function newMessageId(): MessageId {
  // crypto.randomUUID exists in MV3 SW and modern Node/Bun.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without randomUUID.
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
