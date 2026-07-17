import { useQuery } from "@tanstack/react-query";

export interface RateCounterView {
  tag: string;
  count: number;
  reset_at: string;
}

const RATE_LIMITS_URL = "http://localhost:7722/rate-limits";

async function fetchRateLimits(): Promise<RateCounterView[]> {
  const res = await fetch(RATE_LIMITS_URL);
  if (!res.ok) throw new Error(`GET /rate-limits ${res.status}`);
  const body = (await res.json()) as { counters: RateCounterView[] };
  return body.counters;
}

export function useRateLimits(): { counters: RateCounterView[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["rate-limits"],
    queryFn: fetchRateLimits,
    refetchInterval: 5000,
    staleTime: 2000,
    retry: false,
  });
  return { counters: query.data ?? [], isLoading: query.isLoading };
}
