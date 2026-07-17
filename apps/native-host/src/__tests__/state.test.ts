import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { loadPersistedGlobalPolicy, persistGlobalPolicy } from "../daemon/state.js";

// HOME is redirected to a tmp dir by src/__tests__/setup.ts.
function stateFilePath(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".fn-browser", "state", "policy.json");
}

describe("daemon global-policy persistence", () => {
  it("round-trips a persisted policy", () => {
    expect(loadPersistedGlobalPolicy()).toBeNull(); // nothing saved yet
    persistGlobalPolicy("act");
    expect(loadPersistedGlobalPolicy()).toBe("act");
    persistGlobalPolicy("ask");
    expect(loadPersistedGlobalPolicy()).toBe("ask");
  });

  it("clears to null", () => {
    persistGlobalPolicy("follow_plan");
    expect(loadPersistedGlobalPolicy()).toBe("follow_plan");
    persistGlobalPolicy(null);
    expect(loadPersistedGlobalPolicy()).toBeNull();
  });

  it("returns null for corrupt or invalid persisted state (no throw)", () => {
    const file = stateFilePath();
    mkdirSync(dirname(file), { recursive: true });
    // Malformed JSON → the parse error is swallowed.
    writeFileSync(file, "{ not json ]");
    expect(loadPersistedGlobalPolicy()).toBeNull();
    // Valid JSON but an unknown policy value → rejected by the isHitlMode guard.
    writeFileSync(file, JSON.stringify({ globalPolicy: "bogus" }));
    expect(loadPersistedGlobalPolicy()).toBeNull();
  });
});
