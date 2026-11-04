import { useQueryClient } from "@tanstack/react-query";
import { STUDIO_EVENTS_ROUTE, type StudioEvent } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import { usePageUi } from "../stores/page-ui";
import { useVaultUi } from "../stores/vault-ui";
import { afterEvent } from "./studio-queries";

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
      void afterEvent(queryClient, digest, event.type);
    });
    return () => source.close();
  }, [digest, queryClient]);
}
