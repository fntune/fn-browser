/**
 * Bounded async semaphore with FIFO waiters.
 *
 * `acquire()` resolves with a `release` function once a permit is free; the
 * caller must invoke `release` exactly once (idempotent) when done. Permits are
 * handed directly to the next waiter on release, so the in-use count never
 * exceeds the configured maximum.
 *
 * Used to cap the *spike rate* of `chrome.debugger.attach` calls in the
 * extension service worker (see attach.ts) when many sessions attach at once.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore requires >= 1 permit (got ${permits})`);
    }
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // Woken by a release that handed its permit straight to us — the global
    // permit count was not incremented, so we don't decrement here.
    return this.makeRelease();
  }

  /** Permits currently available (test/observability aid). */
  get available(): number {
    return this.permits;
  }

  /** Callers currently waiting for a permit (test/observability aid). */
  get pending(): number {
    return this.waiters.length;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit to the next waiter without touching the count.
        next();
      } else {
        this.permits++;
      }
    };
  }
}
