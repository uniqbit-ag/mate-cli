import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkRequest, WorkResult } from "@uniqbit/mate-core/studio";

import { afterWorkAction } from "../../lib/studio-queries";
import { runWorkAction } from "../../server/work";

/** A fresh transaction key per confirmation, so an unclear push is recognized afterwards. */
export function newWorkKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** One Work action through the validated server function; Work and the Factory refetch after it. */
export function useWorkAction(companion: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: WorkRequest): Promise<WorkResult> =>
      runWorkAction({ data: { companion, request } }),
    onSettled: () => afterWorkAction(queryClient, companion),
  });
}

/** What a refusal kind tells the person to do next. */
export const REFUSAL_HINTS: Record<string, string> = {
  stale: "Something changed meanwhile. Review the current state and confirm again.",
  "factory-unavailable": "The local factory cannot take this now.",
  access: "This needs write access, or it is someone else's.",
};
