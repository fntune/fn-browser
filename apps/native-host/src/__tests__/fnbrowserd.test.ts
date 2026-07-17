import { describe, expect, it } from "vitest";

import { evaluateExtensionUpgrade, tokenMatches } from "../fnbrowserd.js";

const EXT = "chrome-extension://dabclohkdjdbpfdcddcfhakjihekecbf";

describe("evaluateExtensionUpgrade — /ws/extension CSWSH gate", () => {
  it("pinned: only the exact extension Origin may connect", () => {
    const cfg = { allowedExtensionOrigin: EXT, extensionToken: undefined };
    expect(evaluateExtensionUpgrade(EXT, null, cfg).ok).toBe(true);
    // a different (even chrome-extension) origin is rejected
    expect(evaluateExtensionUpgrade("chrome-extension://otherextensionidaaaaaaaaaaaaaaaa", null, cfg)).toEqual({
      ok: false,
      status: 403,
    });
    // a web page Origin is rejected
    expect(evaluateExtensionUpgrade("https://evil.example", null, cfg).ok).toBe(false);
    // a missing Origin is rejected when pinned (must be the extension)
    expect(evaluateExtensionUpgrade(null, null, cfg).ok).toBe(false);
  });

  it("unpinned dev: blocks non-extension web Origins, allows extension or no-Origin clients", () => {
    const cfg = { allowedExtensionOrigin: null, extensionToken: undefined };
    expect(evaluateExtensionUpgrade("https://evil.example", null, cfg)).toEqual({ ok: false, status: 403 });
    expect(evaluateExtensionUpgrade(EXT, null, cfg).ok).toBe(true);
    // no-Origin non-browser client is fine in dev (not the CSWSH threat)
    expect(evaluateExtensionUpgrade(null, null, cfg).ok).toBe(true);
  });

  it("token mode: requires a correct ?token, regardless of Origin pinning", () => {
    const cfg = { allowedExtensionOrigin: EXT, extensionToken: "s3cret" };
    // right origin, missing token → forbidden
    expect(evaluateExtensionUpgrade(EXT, null, cfg).ok).toBe(false);
    // right origin, wrong token → forbidden
    expect(evaluateExtensionUpgrade(EXT, "nope", cfg).ok).toBe(false);
    // right origin, correct token → ok
    expect(evaluateExtensionUpgrade(EXT, "s3cret", cfg).ok).toBe(true);
    // correct token but wrong origin is STILL rejected (origin checked first)
    expect(evaluateExtensionUpgrade("https://evil.example", "s3cret", cfg).ok).toBe(false);
  });

  it("token mode unpinned: a no-Origin client still needs the token", () => {
    const cfg = { allowedExtensionOrigin: null, extensionToken: "s3cret" };
    expect(evaluateExtensionUpgrade(null, null, cfg).ok).toBe(false);
    expect(evaluateExtensionUpgrade(null, "s3cret", cfg).ok).toBe(true);
  });
});

describe("tokenMatches — constant-time compare", () => {
  it("matches equal tokens and rejects mismatches/null/length-diff", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false); // length mismatch
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });
});
