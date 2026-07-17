/**
 * Stop-overlay content script. Injected into tabs under active automation.
 *
 * Detection hygiene: mounts inside a closed Shadow DOM attached to a host node
 * with a randomized per-session ID. Page JS cannot read the closed shadow root
 * (no foreign DOM footprint) and cannot MutationObserver-probe well-known IDs.
 *
 * Cleanup happens on a chrome.runtime message from the background SW (e.g.
 * when chrome.debugger.onDetach fires). No forensic artifacts linger after run
 * completion.
 */

const HOST_ID = `fn-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

let hostElement: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;

function mount(): void {
  if (hostElement) return;

  hostElement = document.createElement("div");
  hostElement.id = HOST_ID;
  hostElement.style.cssText =
    "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;";

  // Closed shadow root: page JS receives `null` from hostElement.shadowRoot.
  shadowRoot = hostElement.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel {
      font: 13px system-ui, sans-serif;
      background: #18181b;
      color: #fafafa;
      padding: 8px 12px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      display: flex; align-items: center; gap: 8px;
    }
    button {
      all: unset;
      cursor: pointer;
      padding: 4px 10px;
      background: #ef4444;
      color: #fafafa;
      border-radius: 4px;
      font-weight: 600;
      font-size: 12px;
    }
    button:hover { background: #dc2626; }
  `;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<span>fn-browser active</span>`;

  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ topic: "stop_clicked" });
  });
  panel.appendChild(stopBtn);

  shadowRoot.appendChild(style);
  shadowRoot.appendChild(panel);

  document.documentElement.appendChild(hostElement);
}

function unmount(): void {
  hostElement?.remove();
  hostElement = null;
  shadowRoot = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.topic === "overlay:mount") {
    mount();
    sendResponse({ ok: true });
  } else if (msg?.topic === "overlay:unmount") {
    unmount();
    sendResponse({ ok: true });
  }
  return true;
});

// Auto-unmount on page unload so we don't leak across navigations.
window.addEventListener("pagehide", unmount);
