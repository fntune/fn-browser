import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChromeTabGroupColor, HitlMode } from "@fn-browser/browser/cdp";

export interface SessionView {
  id: string;
  name: string;
  color: ChromeTabGroupColor;
  /** null until the session's first tab lazily creates its Chrome tab group. */
  tabGroupId: number | null;
  windowId: number | null;
  policy: HitlMode;
  ownedTabCount: number;
  workflowRunIds: string[];
  createdAt: string;
  lastHeartbeat: string;
}

const SESSIONS_URL = "http://localhost:7722/sessions";

async function fetchSessions(): Promise<SessionView[]> {
  const res = await fetch(SESSIONS_URL);
  if (!res.ok) throw new Error(`GET /sessions ${res.status}`);
  const body = (await res.json()) as { sessions: SessionView[] };
  return body.sessions;
}

async function setPolicyRequest(args: { id: string; policy: HitlMode }): Promise<void> {
  const res = await fetch(`${SESSIONS_URL}/${encodeURIComponent(args.id)}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy: args.policy }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /sessions/:id/policy ${res.status}: ${text}`);
  }
}

export function useSessions(): {
  sessions: SessionView[];
  isLoading: boolean;
  isError: boolean;
  setPolicy: (id: string, policy: HitlMode) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["sessions"],
    queryFn: fetchSessions,
    refetchInterval: 2000,
    staleTime: 1000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: setPolicyRequest,
    onMutate: async ({ id, policy }) => {
      await queryClient.cancelQueries({ queryKey: ["sessions"] });
      const previous = queryClient.getQueryData<SessionView[]>(["sessions"]) ?? [];
      queryClient.setQueryData<SessionView[]>(["sessions"], (old) =>
        (old ?? []).map((s) => (s.id === id ? { ...s, policy } : s)),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["sessions"], ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });

  return {
    sessions: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    setPolicy: (id, policy) => mutation.mutate({ id, policy }),
  };
}
