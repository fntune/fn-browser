/**
 * Mirror of the wire protocol defined in the extension. Kept separate (copy,
 * not import) because the extension imports from @fn-browser/browser but the host's
 * build target is Bun / Node, not the browser.
 */

export const PROTOCOL_VERSION = 1;
export type MessageId = string;

export interface HostHello {
  id: MessageId;
  kind: "hello";
  extensionVersion: string;
  protocolVersion: number;
  /** Absent from extension builds before per-profile ids. */
  browser?: { id: string; label: string };
}

export interface HostHelloAck {
  id: MessageId;
  kind: "hello_ack";
  hostVersion: string;
  protocolVersion: number;
}

/** App-level liveness over the WebSocket transport (see the extension mirror).
 * The daemon sends `ping` periodically; the extension answers `pong`. */
export interface HostPing {
  id: MessageId;
  kind: "ping";
}

export interface ExtensionPong {
  id: MessageId;
  kind: "pong";
}

export interface HostToExtensionCommand {
  id: MessageId;
  kind: "command";
  method: string;
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
  error: { code: string; message: string; details?: unknown };
}

export interface ExtensionToHostEvent {
  id: MessageId;
  kind: "event";
  topic: string;
  payload: Record<string, unknown>;
}

export type NativeMessage =
  | HostHello
  | HostHelloAck
  | HostPing
  | ExtensionPong
  | HostToExtensionCommand
  | ExtensionToHostResponse
  | ExtensionToHostError
  | ExtensionToHostEvent;

export function newMessageId(): MessageId {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
