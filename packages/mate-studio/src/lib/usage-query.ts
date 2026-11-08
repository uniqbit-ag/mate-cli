import { queryOptions } from "@tanstack/react-query";
import { getUsage } from "../server/usage";

/** Deliberately outside eager view prefetch. */
export const usageQuery = (companion: string, days: number) =>
  queryOptions({
    queryKey: [companion, "usage", days] as const,
    queryFn: () => getUsage({ data: { companion, days } }),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
