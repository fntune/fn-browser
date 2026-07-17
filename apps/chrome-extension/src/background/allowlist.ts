/**
 * Per-origin consent allowlist, persisted in chrome.storage.local so it
 * survives extension reloads and host respawns. When the host asks the
 * extension for consent and the target tab's origin is in this list, we
 * resolve `{choice: "allow"}` immediately — no modal shown to the user.
 *
 * Scope decision: the allowlist short-circuits BOTH destructive and
 * non-destructive consents for the allowlisted origin. Users only add an
 * origin here through an explicit "Always allow on X" click in the consent
 * modal or by typing one into the side-panel Trusted Sites section, so
 * consent is always the bar for entry.
 */

const STORAGE_KEY = "fnAllowedOrigins";

type Listener = (origins: string[]) => void;
const listeners = new Set<Listener>();

async function readRaw(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const v = result[STORAGE_KEY];
  return Array.isArray(v) ? (v.filter((o) => typeof o === "string") as string[]) : [];
}

async function writeRaw(next: string[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export async function listOrigins(): Promise<string[]> {
  return readRaw();
}

export async function hasOrigin(origin: string): Promise<boolean> {
  const list = await readRaw();
  return list.includes(origin);
}

export async function addOrigin(origin: string): Promise<string[]> {
  const list = await readRaw();
  if (list.includes(origin)) return list;
  const next = [...list, origin].sort();
  await writeRaw(next);
  return next;
}

export async function removeOrigin(origin: string): Promise<string[]> {
  const list = await readRaw();
  const next = list.filter((o) => o !== origin);
  await writeRaw(next);
  return next;
}

/**
 * Subscribe to allowlist changes from ANY source — this tab, another tab's
 * panel, extension reload, chrome sync, etc. Fires with the current list on
 * subscribe so late subscribers get the current state.
 */
export function subscribeAllowlist(listener: Listener): () => void {
  listeners.add(listener);
  void readRaw().then((current) => listener(current)).catch(() => {});
  return () => {
    listeners.delete(listener);
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!(STORAGE_KEY in changes)) return;
  const raw = changes[STORAGE_KEY]?.newValue;
  const next: string[] = Array.isArray(raw)
    ? (raw.filter((o) => typeof o === "string") as string[])
    : [];
  for (const l of listeners) {
    try {
      l(next);
    } catch (err) {
      console.error("[allowlist] listener threw:", err);
    }
  }
});
