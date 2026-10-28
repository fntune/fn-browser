import { describe, expect, it } from "vitest";
import type { SessionId } from "@fn-browser/browser/cdp";

import { createSessionIdentity } from "../session-identity.js";

const SIGNING_KEY = "test-session-signing-key-32-bytes-minimum";

describe("createSessionIdentity", () => {
  it("creates opaque ids that verify only for their authenticated owner", () => {
    const identity = createSessionIdentity(SIGNING_KEY);
    const sessionId = identity.createSessionId("alice");

    expect(sessionId).toMatch(/^v1\./);
    expect(sessionId).not.toContain("alice");
    expect(identity.verifiesOwner(sessionId, "alice")).toBe(true);
    expect(identity.verifiesOwner(sessionId, "bob")).toBe(false);
    expect(identity.verifiesOwner(`${sessionId}x` as SessionId, "alice")).toBe(false);
  });

  it("keeps local ids unsigned and fails authenticated restore closed without a key", () => {
    const identity = createSessionIdentity(undefined);
    const localId = identity.createSessionId(undefined);
    const authenticatedId = identity.createSessionId("alice");

    expect(localId).toMatch(/^[0-9a-f-]{36}$/);
    expect(authenticatedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.verifiesOwner(authenticatedId, "alice")).toBe(false);
  });

  it("rejects short signing keys at startup", () => {
    expect(() => createSessionIdentity("too-short")).toThrow(/at least 32 bytes/);
  });
});
