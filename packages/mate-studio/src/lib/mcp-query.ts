import { queryOptions } from "@tanstack/react-query";
import type { McpManagerState } from "@uniqbit/mate-core/studio";

import { getMcpManager, previewMcpManager } from "../server/mcp-manager";

const SCOPE = "mcp";

export const mcpManagerQuery = (companion: string) =>
  queryOptions({
    queryKey: [companion, SCOPE] as const,
    queryFn: () => getMcpManager({ data: { companion } }),
    // An invalid framework.yaml stays invalid; the view reports it at once and offers Retry.
    retry: false,
  });

/** What core derives from unsaved state, or its validation error; held briefly per state. */
export const mcpPreviewQuery = (companion: string, next: McpManagerState) =>
  queryOptions({
    queryKey: [companion, SCOPE, "preview", next] as const,
    queryFn: () => previewMcpManager({ data: { companion, next } }),
    gcTime: 60_000,
  });
