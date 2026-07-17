import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { SessionId } from "@fntune/browser/cdp";

const MIN_SIGNING_KEY_BYTES = 32;
const SIGNED_SESSION_PATTERN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export interface SessionIdentity {
  createSessionId(ownerPrincipalId: string | undefined): SessionId;
  verifiesOwner(sessionId: SessionId, principalId: string): boolean;
}

/** Create opaque, principal-bound identities for authenticated session restore. */
export function createSessionIdentity(rawSigningKey: string | undefined): SessionIdentity {
  const signingKey = rawSigningKey === "" ? undefined : rawSigningKey;
  if (signingKey && Buffer.byteLength(signingKey, "utf8") < MIN_SIGNING_KEY_BYTES) {
    throw new Error(
      `FN_BROWSER_SESSION_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes when set`,
    );
  }

  const signature = signingKey
    ? (principalId: string, nonce: string): Buffer =>
        createHmac("sha256", signingKey)
          .update(JSON.stringify([principalId, nonce]), "utf8")
          .digest()
    : undefined;

  return {
    createSessionId(ownerPrincipalId): SessionId {
      const nonce = randomUUID();
      if (!ownerPrincipalId || !signature) return nonce as SessionId;
      const encoded = signature(ownerPrincipalId, nonce).toString("base64url");
      return `v1.${nonce}.${encoded}` as SessionId;
    },
    verifiesOwner(sessionId, principalId): boolean {
      if (!signature) return false;
      const match = SIGNED_SESSION_PATTERN.exec(sessionId);
      if (!match) return false;
      const [, nonce, encoded] = match;
      if (!nonce || !encoded) return false;
      const actual = Buffer.from(encoded, "base64url");
      const expected = signature(principalId, nonce);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
