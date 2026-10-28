/**
 * MV3 service worker entry. Wires the native-messaging port to the CDP command
 * router. Stays alive while the port is open (Chrome 116+ keeps SWs alive for
 * active connectNative ports).
 *
 * Also owns the long-lived port to the side panel (name=sidepanel) — pushes
 * host status + consent queue state, receives consent resolutions back.
 */

import { NativePort, type NativePortEvents } from "./native-port.js";
import { WsPort } from "./ws-port.js";
import {
  DAEMON_URL_KEY,
  EXTENSION_TOKEN_KEY,
  daemonConfigSnapshot,
  detectLocalDaemon,
  resolveTransportConfig,
} from "./transport-config.js";
import { createCommandRouter } from "./command-router.js";
import { resolveBrowserIdentity } from "./identity.js";
import { consentQueue } from "./consent-queue.js";
import {
  addOrigin as allowlistAdd,
  removeOrigin as allowlistRemove,
  subscribeAllowlist,
} from "./allowlist.js";
import { installTabGroupEventForwarder } from "./session-group.js";
import type { NativeMessage, PanelToSwMessage, SwToPanelMessage } from "../shared/protocol.js";
import { SIDEPANEL_PORT_NAME, newMessageId } from "../shared/protocol.js";

// Attached-tab count tracked locally so the side panel can display it. The
// command router doesn't expose this directly — we watch chrome.debugger
// events instead.
const attachedTabs = new Set<number>();

// Side-panel ports (there can be multiple — per Chrome window). Every update
// broadcasts to all of them.
const sidePanelPorts = new Set<chrome.runtime.Port>();

/** The active transport to the host/daemon — exactly ONE per boot (see
 * initTransport): the native-messaging shim OR the WebSocket daemon client,
 * never both. `null` until the async config read picks one. */
interface Transport {
  connect(): void;
  send(message: NativeMessage): void;
  readonly isConnected: boolean;
}
let port: Transport | null = null;

function broadcastToPanels(msg: SwToPanelMessage): void {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(msg);
    } catch (err) {
      console.warn("[fn-browser] sidepanel postMessage failed:", err);
    }
  }
}

function pushHostStatus(): void {
  broadcastToPanels({
    topic: "host:status",
    connected: port?.isConnected ?? false,
    attachedTabs: attachedTabs.size,
  });
}

function pushConsentSnapshot(): void {
  broadcastToPanels({
    topic: "consent:update",
    pending: consentQueue.listPending(),
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    pushHostStatus();
  }
});

const events: NativePortEvents = {
  onConnect: () => {
    console.log("[fn-browser] host transport connected");
    pushHostStatus();
    void chrome.windows
      .getLastFocused()
      .then((window) => {
        if (window.focused) sendFocused();
      })
      .catch(() => {
        /* no windows open */
      });
  },
  onDisconnect: (reason) => {
    console.warn("[fn-browser] host transport disconnected:", reason);
    // The side panel can't deliver a user response with the link down — fail
    // in-flight consents fast instead of hanging to the host's 10-min timeout.
    consentQueue.rejectAll(`host transport disconnected: ${reason}`);
    pushHostStatus();
  },
  onCommand: (cmd) => {
    if (cmd.method === "upload_file" || cmd.method === "navigate" || cmd.method === "click") {
      const tabId = (cmd.params as { tabId?: number }).tabId;
      if (typeof tabId === "number") {
        const added = !attachedTabs.has(tabId);
        attachedTabs.add(tabId);
        if (added) pushHostStatus();
      }
    }
    void router.handle(cmd);
  },
  onError: (err) => {
    console.error("[fn-browser] host transport error:", err);
  },
};

// Long-lived side-panel connection. Panel initiates; SW pushes state.
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== SIDEPANEL_PORT_NAME) return;

  sidePanelPorts.add(p);

  // Subscribe the queue for this port's lifetime; unsubscribe on disconnect.
  const unsubscribeConsent = consentQueue.subscribe((pending) => {
    try {
      p.postMessage({ topic: "consent:update", pending } satisfies SwToPanelMessage);
    } catch {
      /* port may have closed in the same tick — handled by onDisconnect */
    }
  });

  const unsubscribeAllowlist = subscribeAllowlist((origins) => {
    try {
      p.postMessage({ topic: "allowlist:update", origins } satisfies SwToPanelMessage);
    } catch {
      /* ignore */
    }
  });

  // Seed the panel with current host status immediately.
  try {
    p.postMessage({
      topic: "host:status",
      connected: port?.isConnected ?? false,
      attachedTabs: attachedTabs.size,
    } satisfies SwToPanelMessage);
  } catch {
    /* ignore */
  }

  // Seed the daemon transport config (mode + url) so the panel can show/edit it.
  void daemonConfigMessage().then((msg) => {
    try {
      p.postMessage(msg);
    } catch {
      /* port may have closed */
    }
  });

  p.onMessage.addListener((incoming: PanelToSwMessage) => {
    if (incoming?.topic === "consent:resolve" && typeof incoming.id === "string") {
      consentQueue.resolve(incoming.id, incoming.choice);
      return;
    }
    if (incoming?.topic === "allowlist:add" && typeof incoming.origin === "string") {
      void allowlistAdd(incoming.origin);
      return;
    }
    if (incoming?.topic === "allowlist:remove" && typeof incoming.origin === "string") {
      void allowlistRemove(incoming.origin);
      return;
    }
    if (incoming?.topic === "daemon:set" && typeof incoming.url === "string") {
      const url = incoming.url.trim();
      // Blank token ⇒ keep the existing one (the panel never receives the secret,
      // so it can't echo it back). Persist, then reload so the SW re-runs
      // transport selection — a clean re-pick beats hot-swapping the live socket.
      void chrome.storage.local
        .get([EXTENSION_TOKEN_KEY])
        .then((cur) => {
          const token =
            incoming.token && incoming.token.length > 0
              ? incoming.token
              : ((cur[EXTENSION_TOKEN_KEY] as string | undefined) ?? "");
          return chrome.storage.local.set({ [DAEMON_URL_KEY]: url, [EXTENSION_TOKEN_KEY]: token });
        })
        .then(() => chrome.runtime.reload());
      return;
    }
    if (incoming?.topic === "daemon:reset") {
      // Drop the explicit config → next boot auto-detects the local daemon.
      void chrome.storage.local
        .remove([DAEMON_URL_KEY, EXTENSION_TOKEN_KEY])
        .then(() => chrome.runtime.reload());
      return;
    }
  });

  p.onDisconnect.addListener(() => {
    unsubscribeConsent();
    unsubscribeAllowlist();
    sidePanelPorts.delete(p);
  });
});

const router = createCommandRouter({
  sendResponse: (msg) => {
    port?.send(msg as NativeMessage);
  },
});

// Open the side panel on action click.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Forward chrome.tabs / chrome.tabGroups changes to the host so the
// SessionRegistry can reconcile ownership after manual user drags.
installTabGroupEventForwarder((event) => {
  port?.send(event as NativeMessage);
});

// With several profiles connected, the host defaults new sessions to the one
// focused last. Each profile's extension only sees its own windows.
function sendFocused(): void {
  port?.send({ id: newMessageId(), kind: "event", topic: "browser_focused", payload: {} });
}
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) sendFocused();
});

/** Build the daemon-config broadcast for the side panel. */
async function daemonConfigMessage(): Promise<SwToPanelMessage> {
  return { topic: "daemon:config", ...daemonConfigSnapshot(await resolveTransportConfig()) };
}

// Single-authority transport selection: resolve the config, then construct
// EXACTLY ONE transport for this SW boot — never both (the WS client and the
// native-messaging shim both want :7722, so building both collides). In WS mode
// we never call connectNative. With no explicit config we AUTO-DETECT: probe
// loopback for a live fn-browserd and use the WS path if it's up, else the shim
// — so "daemon running ⇒ used" needs no config (explicit fnDaemonUrl is only for
// a remote/tailnet daemon). Must run before any command can arrive — the SW's
// startup kickoff.
async function initTransport(): Promise<void> {
  const [cfg, browser] = await Promise.all([resolveTransportConfig(), resolveBrowserIdentity()]);
  if (cfg.mode === "ws") {
    port = new WsPort({ url: cfg.url, token: cfg.token, browser }, events);
  } else if (cfg.mode === "shim") {
    port = new NativePort(events, browser);
  } else {
    const wsUrl = await detectLocalDaemon();
    port = wsUrl ? new WsPort({ url: wsUrl, token: "", browser }, events) : new NativePort(events, browser);
    console.log(`[fn-browser] auto-detected transport: ${wsUrl ? "websocket daemon" : "native-messaging shim"}`);
  }
  port.connect();
}
void initTransport();

// Enable side panel on every tab so the action can open it.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// When consent queue changes, keep all connected panels in sync. (The
// per-port subscription above handles the happy path; this guarantees
// listeners that were added to the global queue also fire a broadcast.)
consentQueue.subscribe(() => pushConsentSnapshot());
