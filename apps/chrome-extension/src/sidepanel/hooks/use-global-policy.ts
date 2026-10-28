import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HitlMode } from "@fn-browser/browser/cdp";

export type GlobalPolicy = HitlMode | null;

const URL = "http://localhost:7722/global-policy";
const STORAGE_KEY = "fnGlobalPolicy";

async function readStorage(): Promise<GlobalPolicy> {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const v = raw[STORAGE_KEY];
    if (v === null || v === "ask" || v === "follow_plan" || v === "act") return v;
    return null;
  } catch {
    return null;
  }
}

async function writeStorage(policy: GlobalPolicy): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: policy });
  } catch {
    /* ignore; host remains source of truth this session */
  }
}

/**
 * Effective global policy is the union of:
 *  - what the host currently says (live source of truth during a session)
 *  - what chrome.storage has cached (survives host respawns; re-pushed on
 *    reconnect so the host picks it up without a manual click)
 *
 * We prefer the host value whenever it exists; storage is a fallback + a
 * persistence layer.
 */
async function fetchGlobal(): Promise<GlobalPolicy> {
  const res = await fetch(URL).catch(() => null);
  if (res && res.ok) {
    const body = (await res.json()) as { policy: GlobalPolicy };
    return body.policy;
  }
  return readStorage();
}

async function writeGlobal(policy: GlobalPolicy): Promise<GlobalPolicy> {
  // Persist locally first so the choice survives even if the POST fails
  // (host may be mid-respawn). A subsequent fetch will re-push.
  await writeStorage(policy);
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /global-policy ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { policy: GlobalPolicy };
  return body.policy;
}

/**
 * On first mount, push the chrome.storage-persisted policy to a freshly
 * spawned host that has no knowledge of it yet. Runs exactly once per panel
 * open; subsequent host restarts will be handled here again via the panel
 * port's reconnect flow (the query re-fetches and sees the host at null).
 */
function useRehydrateToHost(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readStorage();
      if (stored === null || cancelled) return;
      try {
        await fetch(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policy: stored }),
        });
        queryClient.invalidateQueries({ queryKey: ["global-policy"] });
      } catch {
        /* host may not be up yet; polling re-fetch will eventually succeed */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);
}

export function useGlobalPolicy(): {
  policy: GlobalPolicy;
  isLoading: boolean;
  setPolicy: (next: GlobalPolicy) => void;
} {
  const queryClient = useQueryClient();
  useRehydrateToHost();

  const query = useQuery({
    queryKey: ["global-policy"],
    queryFn: fetchGlobal,
    refetchInterval: 4000,
    staleTime: 2000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: writeGlobal,
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["global-policy"] });
      const previous = queryClient.getQueryData<GlobalPolicy>(["global-policy"]) ?? null;
      queryClient.setQueryData<GlobalPolicy>(["global-policy"], next);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) queryClient.setQueryData(["global-policy"], ctx.previous);
    },
    onSuccess: (applied) => queryClient.setQueryData(["global-policy"], applied),
  });

  return {
    policy: query.data ?? null,
    isLoading: query.isLoading,
    setPolicy: (next) => mutation.mutate(next),
  };
}
