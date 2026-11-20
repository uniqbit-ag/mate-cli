import { createServerFn } from "@tanstack/react-start";
import {
  FACTORY_ACTION_ROUTE,
  FACTORY_BOARD_ROUTE,
  FACTORY_REPOSITORIES_ROUTE,
  FACTORY_SERVICE_ID,
  type FactoryRunView,
  OUTCOME_ACTIONS,
  type OutcomeAction,
  type RepositoryAddInput,
  type RepositoryAddResult,
} from "@uniqbit/mate-core/factory-studio";
import {
  COMPANION_DIGEST_PATTERN,
  companionDigest,
  type StudioChange,
  type StudioCompanionPayload,
  type StudioServices,
} from "@uniqbit/mate-core/studio";

/** What the Factory reads from the companion payload; nothing else crosses to the browser. */
export type FactoryPayload = Pick<
  StudioCompanionPayload,
  "worksets" | "linkedRepositories" | "ticketFormat" | "worksetProblems" | "warnings"
> & {
  /** Where each offered repository comes from; only the list's own can be removed in Studio. */
  repositorySources?: StudioCompanionPayload["repositorySources"];
  /** Each repository's Git token key (`host/org`), matched against the stored token keys. */
  repositoryKeys?: StudioCompanionPayload["repositoryKeys"];
  /** Task counts per change, for a running Outcome's progress. */
  changes?: Pick<StudioChange, "name" | "completedTasks" | "totalTasks">[];
};

/** Board actions a person can take: core's Outcome actions, plus `create`, which needs no runner. */
const FACTORY_ACTIONS = ["create", ...OUTCOME_ACTIONS] as const;

export type FactoryAction = "create" | OutcomeAction;

export interface FactoryActionInput {
  companion: string;
  action: FactoryAction;
  /** The Outcome acted on; absent only for `create`. */
  id?: string;
  /** The form's fields, as the server-rendered forms posted them. */
  fields: Record<string, string>;
}

const MAX_FIELD = 64 * 1024;

function validate(input: FactoryActionInput): FactoryActionInput {
  if (typeof input?.companion !== "string" || !COMPANION_DIGEST_PATTERN.test(input.companion)) {
    throw new Error("no registered companion was selected");
  }
  if (!(FACTORY_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`unknown factory action ${JSON.stringify(input.action)}`);
  }
  if (input.action !== "create" && typeof input.id !== "string") {
    throw new Error("the action names no Outcome");
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    if (typeof value === "string" && value.length <= MAX_FIELD) fields[name] = value;
  }
  return { companion: input.companion, action: input.action, id: input.id, fields };
}

/**
 * Calls one of the factory service's routes in process; this server function's own guard stood
 * for origin and token. A refusal's reason is thrown, as the services' errors were.
 */
async function callFactory<T>(
  studio: StudioServices,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const response = await studio.callService(
    new Request(`http://studio.local${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  const answer = (text.startsWith("{") ? JSON.parse(text) : { reason: text }) as T & {
    reason?: string;
  };
  if (!response.ok) throw new Error(answer.reason ?? `the factory answered ${response.status}`);
  return answer;
}

/** Whether the factory service runs in this Studio: only then is the Factory view offered. */
export const factoryModeOf = (studio: StudioServices): boolean =>
  studio.services().some((service) => service.id === FACTORY_SERVICE_ID);

/** One Outcome action, checked by the factory service exactly as the old form posts were. */
export const runFactoryAction = createServerFn({ method: "POST" })
  .validator(validate)
  .handler(async ({ data, context }) => {
    if (!context.studio.writable) {
      throw new Error("start Studio with --writable to create or start Worksets");
    }
    await callFactory(context.studio, "POST", FACTORY_ACTION_ROUTE, data);
    return { ok: true as const };
  });

/** The Factory's view model: the companion payload, its runs and sessions, at one moment. */
export const getFactory = createServerFn({ method: "GET" })
  .validator((input: { companion: string }) => {
    if (!COMPANION_DIGEST_PATTERN.test(input?.companion ?? "")) {
      throw new Error("no registered companion was selected");
    }
    return { companion: input.companion };
  })
  .handler(async ({ data, context }) => {
    const url = new URL("http://studio.local/");
    url.searchParams.set("companion", data.companion);
    url.searchParams.set("view", "factory");
    // Outcomes change outside this page (runs, other tabs), so the board always collects afresh,
    // as the server-rendered board did on each of its refreshes.
    url.searchParams.set("refresh", "1");
    const page = await context.studio.page(url);
    if (!page.companion || companionDigest(page.companion.path) !== data.companion) {
      throw new Error("no registered companion was selected");
    }
    const payload = page.payload;
    const factoryMode = factoryModeOf(context.studio);
    const board = factoryMode
      ? await callFactory<{
          runs: Record<string, FactoryRunView> | null;
          sessions: Record<string, string> | null;
        }>(
          context.studio,
          "GET",
          `${FACTORY_BOARD_ROUTE}?companion=${encodeURIComponent(data.companion)}`,
        )
      : { runs: null, sessions: null };
    return {
      payload: payload
        ? ({
            worksets: payload.worksets,
            changes: payload.changes.map(({ name, completedTasks, totalTasks }) => ({
              name,
              completedTasks,
              totalTasks,
            })),
            linkedRepositories: payload.linkedRepositories,
            repositorySources: payload.repositorySources,
            repositoryKeys: payload.repositoryKeys,
            ticketFormat: payload.ticketFormat,
            worksetProblems: payload.worksetProblems,
            warnings: payload.warnings,
          } satisfies FactoryPayload)
        : null,
      error: page.error?.reason ?? null,
      runs: board.runs,
      sessions: board.sessions,
      writable: page.writable,
      factoryMode,
      renderedAt: page.renderedAt ?? Date.now(),
    };
  });

function checkedCompanion(companion: unknown): string {
  if (typeof companion !== "string" || !COMPANION_DIGEST_PATTERN.test(companion)) {
    throw new Error("no registered companion was selected");
  }
  return companion;
}

/** Adds a Working Repository to the companion's list; a refusal comes back as an answer with its reason. */
export const addRepository = createServerFn({ method: "POST" })
  .validator((input: { companion: string; input: RepositoryAddInput }) => {
    const companion = checkedCompanion(input?.companion);
    const given = input.input;
    if (given?.kind === "url" && typeof given.url === "string") {
      return { companion, input: { kind: "url", url: given.url } satisfies RepositoryAddInput };
    }
    if (given?.kind === "path" && typeof given.path === "string") {
      return { companion, input: { kind: "path", path: given.path } satisfies RepositoryAddInput };
    }
    throw new Error("name a Git URL or a path");
  })
  .handler(({ data, context }): Promise<RepositoryAddResult> =>
    repositories<RepositoryAddResult>(context.studio, "POST", data),
  );

/** Removes an entry the companion's list holds. */
export const removeRepository = createServerFn({ method: "POST" })
  .validator((input: { companion: string; identity: string }) => {
    if (typeof input?.identity !== "string") throw new Error("name the repository to remove");
    return { companion: checkedCompanion(input.companion), identity: input.identity };
  })
  .handler(({ data, context }) =>
    repositories<{ ok: true } | { ok: false; reason: string }>(context.studio, "DELETE", data),
  );

/** The repository route's answer; a refusal, also of a read-only Studio, is an answer. */
async function repositories<T>(studio: StudioServices, method: string, body: unknown): Promise<T> {
  try {
    return await callFactory<T>(studio, method, FACTORY_REPOSITORIES_ROUTE, body);
  } catch (error) {
    return { ok: false, reason: (error as Error).message } as T;
  }
}
