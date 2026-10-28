/**
 * Minimal durable daemon state under `~/.fn-browser/state/`.
 *
 * Scope: the global HITL policy, so a panel/HTTP-set policy survives a daemon
 * restart. Live session/tab-group bindings are intentionally NOT persisted —
 * they reconcile when the extension reconnects (the deferred recovery hook), so
 * persisting them here would just record stale ids.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HitlMode } from "@fn-browser/browser/cdp";

interface PolicyState {
  globalPolicy: HitlMode | null;
}

function stateFile(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".fn-browser", "state", "policy.json");
}

function isHitlMode(value: unknown): value is HitlMode {
  return value === "ask" || value === "act" || value === "follow_plan";
}

export function loadPersistedGlobalPolicy(): HitlMode | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<PolicyState>;
    return isHitlMode(parsed.globalPolicy) ? parsed.globalPolicy : null;
  } catch {
    // Missing/unreadable/corrupt state file → no persisted policy.
    return null;
  }
}

export function persistGlobalPolicy(policy: HitlMode | null): void {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    const state: PolicyState = { globalPolicy: policy };
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch (err) {
    console.error("[daemon-state] failed to persist global policy:", err);
  }
}
