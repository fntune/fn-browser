/**
 * This profile's browser identity, sent in the hello so the host keeps one
 * connection per Chrome profile. The id is random and stored per profile; the
 * label is the profile's signed-in email when there is one.
 */

import type { BrowserIdentity } from "../shared/protocol.js";

const BROWSER_ID_KEY = "fnBrowserId";

export async function resolveBrowserIdentity(): Promise<BrowserIdentity> {
  const stored = await chrome.storage.local.get(BROWSER_ID_KEY);
  let id = stored[BROWSER_ID_KEY];
  if (typeof id !== "string") {
    id = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ [BROWSER_ID_KEY]: id });
  }
  return { id, label: (await profileEmail()) || id };
}

async function profileEmail(): Promise<string> {
  try {
    const info = await chrome.identity.getProfileUserInfo({
      accountStatus: chrome.identity.AccountStatus.ANY,
    });
    return info.email;
  } catch (err) {
    // Browsers without the identity API (or a missing permission) still connect, labeled by id.
    console.warn("[fn-browser] profile email unavailable:", err);
    return "";
  }
}
