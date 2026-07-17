/** Append-only security audit log under ~/.fn-browser/audit/. */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuditEntry {
  kind: string;
  /** Principal id (audit label), when known. */
  principal?: string;
  [key: string]: unknown;
}

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private ensured = false;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Enqueue append; never throws into caller — disk failure goes to stderr. */
  append(entry: AuditEntry): Promise<void> {
    const at = this.clock().toISOString();
    const line = `${JSON.stringify({ at, ...entry })}\n`;
    const day = at.slice(0, 10);
    this.chain = this.chain.then(async () => {
      try {
        const dir = this.dir();
        if (!this.ensured) {
          await mkdir(dir, { recursive: true });
          this.ensured = true;
        }
        await appendFile(join(dir, `${day}.jsonl`), line);
      } catch (err) {
        console.error("[audit] append failed:", err);
      }
    });
    return this.chain;
  }

  private dir(): string {
    const home = process.env.HOME ?? homedir();
    return join(home, ".fn-browser", "audit");
  }
}
