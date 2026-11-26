import { useQueryClient } from "@tanstack/react-query";
import { STUDIO_EVENTS_ROUTE, type StudioEvent } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import { studioConnection } from "../stores/connection";
import { usePageUi } from "../stores/page-ui";
import { useVaultUi } from "../stores/vault-ui";
import { afterEvent } from "./studio-queries";

/** Follows the companion's event stream for as long as the page shows it. */
export function useStudioEvents(digest: string | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!digest || typeof EventSource === "undefined") return;
    const connection = studioConnection();
    let source: EventSource;
    let waiting: (() => void) | null = null;
    const onMessage = (message: MessageEvent<string>) => {
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
    };
    // A stream the browser still reconnects is left to it; a closed one reopens once online.
    const onError = () => {
      connection?.suspect();
      if (source.readyState !== EventSource.CLOSED || !connection || waiting) return;
      waiting = connection.subscribe((state) => {
        if (state !== "online") return;
        waiting?.();
        waiting = null;
        open();
      });
    };
    const open = () => {
      source = new EventSource(`${STUDIO_EVENTS_ROUTE}?companion=${encodeURIComponent(digest)}`);
      source.addEventListener("message", onMessage);
      source.addEventListener("error", onError);
    };
    open();
    return () => {
      waiting?.();
      source.close();
    };
  }, [digest, queryClient]);
}
