import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { type ConnectionMonitor, startConnectionMonitor } from "../stores/connection";

/**
 * The page's query client. In the browser every failed query or mutation makes the page's
 * connection monitor probe; during SSR there is no monitor, so `window` stays untouched.
 */
export function createStudioQueryClient(): QueryClient {
  let monitor: ConnectionMonitor | null = null;
  const suspect = () => monitor?.suspect();
  // Held for the page's life: a revisit shows its data at once and refreshes it if stale.
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: suspect }),
    mutationCache: new MutationCache({ onError: suspect }),
    defaultOptions: { queries: { staleTime: 5_000, gcTime: Infinity } },
  });
  if (typeof window !== "undefined") monitor = startConnectionMonitor({ queryClient });
  return queryClient;
}
