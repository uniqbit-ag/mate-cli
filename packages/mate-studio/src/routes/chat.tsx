import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { shellQuery } from "../lib/studio-queries";
import { ChatView } from "../views/chat/chat-view";

/** Offered in Analysis only, and only on a local-only Studio; the root sends any other address to the Overview. */
export const Route = createFileRoute("/chat")({
  staticData: { view: "chat" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  // The conversation lives in this tab only, so there is nothing to render on the server.
  ssr: false,
  loader: ({ context, deps }) => registeredCompanion(context.queryClient, deps),
  component: function ChatRoute() {
    const companion = Route.useLoaderData();
    const search = Route.useSearch();
    const { data: shell } = useSuspenseQuery(
      shellQuery({ companion: search.companion, studioMode: search.studioMode }),
    );
    const selected = shell.selected;
    const roots = selected
      ? [selected.path, ...(selected.realPath ? [selected.realPath] : [])]
      : [];
    // Keyed by companion: switching starts an empty conversation.
    return companion ? <ChatView key={companion} companion={companion} roots={roots} /> : null;
  },
});
