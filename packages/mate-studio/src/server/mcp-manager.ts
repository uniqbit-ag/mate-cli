import { createServerFn } from "@tanstack/react-start";
import { COMPANION_DIGEST_PATTERN, type McpManagerState } from "@uniqbit/mate-core/studio";

/** Far above any real section; core validates what is inside. */
const MAX_STATE = 256 * 1024;

function companionOf(input: { companion?: unknown }): string {
  if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
    throw new Error("no registered companion was selected");
  }
  return input.companion;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The outer shape and size only. */
function stateOf(input: { next?: unknown }): McpManagerState {
  const next = input?.next;
  if (
    !isRecord(next) ||
    !(next.catalog === null || isRecord(next.catalog)) ||
    !isRecord(next.audiences) ||
    !Object.values(next.audiences).every(isRecord)
  ) {
    throw new Error("the request holds no mcpManager state");
  }
  if (JSON.stringify(next).length > MAX_STATE) {
    throw new Error("the mcpManager state exceeds the size limit");
  }
  return { catalog: next.catalog, audiences: next.audiences } as McpManagerState;
}

interface StateInput {
  companion: string;
  next: McpManagerState;
}

export const getMcpManager = createServerFn({ method: "GET" })
  .validator((input: { companion: string }) => ({ companion: companionOf(input) }))
  .handler(({ data, context }) => context.studio.mcpManager(data.companion));

/** Effective sets and variable states for unsaved state, or core's validation error. */
export const previewMcpManager = createServerFn({ method: "POST" })
  .validator((input: StateInput): StateInput => ({
    companion: companionOf(input),
    next: stateOf(input),
  }))
  .handler(({ data, context }) => context.studio.mcpManagerPreview(data.companion, data.next));

/** A save; a stale token comes back as a conflict carrying the current view. */
export const saveMcpManager = createServerFn({ method: "POST" })
  .validator((input: StateInput & { token: string }) => {
    if (typeof input?.token !== "string" || !/^[0-9a-f]{64}$/.test(input.token)) {
      throw new Error("save requires the token of the last read");
    }
    return { companion: companionOf(input), next: stateOf(input), token: input.token };
  })
  .handler(({ data, context }) =>
    context.studio.mcpManagerSave(data.companion, data.next, data.token),
  );
