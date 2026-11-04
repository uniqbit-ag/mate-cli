import { useQueryClient } from "@tanstack/react-query";
import { STUDIO_EVENTS_ROUTE, type StudioEvent } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import { usePageUi } from "../stores/page-ui";
import { useVaultUi } from "../stores/vault-ui";

/** Query keys each event makes stale; views refetch them in place (design D7). */
const EVENT_KEYS: Record<StudioEvent["type"], (digest: string) => readonly unknown[][]> = {
  board: (digest) => [["factory", digest], ["shell"]],
  reports: (digest) => [["reports", digest]],
  // The vault only marks its tree stale; the viewer refreshes it (studio-vault).
  "vault-tree": () => [],
};

/** Follows the companion's event stream for as long as the page shows it. */
export function useStudioEvents(digest: string | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!digest || typeof EventSource === "undefined") return;
    const source = new EventSource(
      `${STUDIO_EVENTS_ROUTE}?companion=${encodeURIComponent(digest)}`,
    );
    source.addEventListener("message", (message) => {
      let event: StudioEvent;
      try {
        event = JSON.parse(message.data) as StudioEvent;
      } catch {
        return;
      }
      if (event.type === "vault-tree") useVaultUi.getState().setGeneration(event.generation);
      // A report published while another view is shown is announced, as before the move.
      if (event.type === "reports" && !location.pathname.startsWith("/reports")) {
        usePageUi.getState().announceReport({ id: event.id, title: event.title });
      }
      for (const queryKey of EVENT_KEYS[event.type]?.(digest) ?? []) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
    return () => source.close();
  }, [digest, queryClient]);
}
