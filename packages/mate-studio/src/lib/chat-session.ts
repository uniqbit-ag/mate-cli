import { queryOptions } from "@tanstack/react-query";
import { CHAT_SESSION_ROUTE, type ChatSession } from "@uniqbit/mate-core/studio";

import { call } from "./agent-credential";

/** What a chat turn for the companion can use; fixed while Studio runs, so read once. */
export const chatSessionQuery = (companion: string) =>
  queryOptions({
    queryKey: [companion, "chat-session"] as const,
    queryFn: () =>
      call<ChatSession>(
        "GET",
        `${CHAT_SESSION_ROUTE}?${new URLSearchParams({ companion }).toString()}`,
      ),
    staleTime: Infinity,
  });
