import { createServerFn } from "@tanstack/react-start";
import {
  COMPANION_DIGEST_PATTERN,
  companionDigest,
  OUTCOME_ACTIONS,
  type OutcomeAction,
  type RepositoryAddInput,
  type RepositoryAddResult,
  type StudioChange,
  type StudioCompanionPayload,
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

/** One Outcome action, checked by core's services exactly as the old form posts were. */
export const runFactoryAction = createServerFn({ method: "POST" })
  .validator(validate)
  .handler(async ({ data, context }) => {
    if (!context.studio.writable) {
      throw new Error("start Studio with --writable to create or start Worksets");
    }
    const field = (name: string) => data.fields[name] ?? "";
    if (data.action === "create") await context.studio.createOutcome(data.companion, field);
    else await context.studio.worksetAction(data.companion, data.id!, data.action, field);
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
      runs: page.factoryRuns ?? null,
      sessions: page.worksetSessions ?? null,
      writable: page.writable,
      factoryMode: context.studio.factoryMode,
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
    context.studio.addRepository(data.companion, data.input),
  );

/** Removes an entry the companion's list holds. */
export const removeRepository = createServerFn({ method: "POST" })
  .validator((input: { companion: string; identity: string }) => {
    if (typeof input?.identity !== "string") throw new Error("name the repository to remove");
    return { companion: checkedCompanion(input.companion), identity: input.identity };
  })
  .handler(({ data, context }) => context.studio.removeRepository(data.companion, data.identity));
