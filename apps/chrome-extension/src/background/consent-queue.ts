/**
 * Consent queue.
 *
 * Holds pending consent requests, surfaces them to the side panel, and
 * resolves when the user responds via the long-lived `chrome.runtime.connect`
 * port (see background/index.ts for the wire-up). Host-side `requireConsent`
 * is bounded by a 10-minute timeout; if the user never resolves, the host
 * rejects the call and the workflow's checkpoint handles the failure.
 */

export interface ConsentRequest {
  id: string;
  title: string;
  body: string;
  options: string[];
  createdAt: number;
  /**
   * Origin of the page the gated action targets, when known (`https://x.y`).
   * Drives the "Always allow on <origin>" option in the side-panel modal
   * and feeds the extension's per-origin allowlist short-circuit.
   */
  origin?: string;
}

export interface ConsentResponse {
  choice: string;
  at: string;
}

interface Pending {
  request: ConsentRequest;
  resolve: (r: ConsentResponse) => void;
  reject: (err: Error) => void;
}

class ConsentQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(reqs: ConsentRequest[]) => void>();

  async request(args: {
    title: string;
    body: string;
    options?: string[];
    origin?: string;
  }): Promise<ConsentResponse> {
    const id = crypto.randomUUID();
    const request: ConsentRequest = {
      id,
      title: args.title,
      body: args.body,
      options: args.options ?? ["allow", "deny"],
      createdAt: Date.now(),
      ...(args.origin ? { origin: args.origin } : {}),
    };

    return new Promise<ConsentResponse>((resolve, reject) => {
      this.pending.set(id, { request, resolve, reject });
      this.notify();
    });
  }

  resolve(id: string, choice: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve({ choice, at: new Date().toISOString() });
    this.notify();
  }

  /**
   * Reject all pending consents on link drop — callers fail fast instead of hanging.
   */
  rejectAll(reason: string): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(new Error(reason));
    this.notify();
  }

  listPending(): ConsentRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  subscribe(handler: (reqs: ConsentRequest[]) => void): () => void {
    this.listeners.add(handler);
    handler(this.listPending());
    return () => {
      this.listeners.delete(handler);
    };
  }

  private notify(): void {
    const snapshot = this.listPending();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[consent-queue] listener threw:", err);
      }
    }
  }
}

export const consentQueue = new ConsentQueue();
