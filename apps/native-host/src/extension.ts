/**
 * The fn-browser extension's stable id.
 *
 * It is derived from the committed manifest `key` in
 * `apps/chrome-extension/manifest.json`, so every build of this repo's extension
 * loads under the same id. Origin pinning (the CSRF guard, side-panel CORS, and
 * the `/ws/extension` WS gate) defaults to this id so that only the REAL
 * fn-browser extension — not any other extension a user happens to have
 * installed with localhost access — is trusted to call the privileged local
 * routes. Override with `FN_BROWSER_EXTENSION_ID` for a custom build.
 */
export const DEFAULT_EXTENSION_ID = "kddgkpcbmpmafljodkcmdjccocmkbdon";

/** The effective pinned extension id: the env override, else the built-in default. */
export function resolveExtensionId(): string {
  const fromEnv = process.env.FN_BROWSER_EXTENSION_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_EXTENSION_ID;
}
