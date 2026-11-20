import path from "node:path";

import { readCompanionWorksetStages } from "../../../cli/commands/studio/payload";
import { errorMessage } from "../../../runtime/error-message";
import type {
  StudioRoute,
  StudioServiceContribution,
  StudioServiceHost,
} from "../../../tools/setup/service";
import { isWorksetId } from "../../workset/record";
import type { WorksetWithStage } from "../../workset/stages";
import { type FactoryClient, factoryClient } from "../client";
import {
  createFactoryOutcomes,
  type FactoryOutcomes,
  type Outcomes,
  type OutcomesPorts,
  recordOutcomes,
} from "../outcomes";
import type { LiveViewer } from "../runner/live";
import { factoryCompanionSource } from "./companion-source";
import { factoryCredentialResponse } from "./credential-route";
import { factoryGitTokensResponse } from "./git-tokens-route";
import { answer, body } from "./relay";
import { addRepository, removeRepository } from "./repository-add";
import {
  FACTORY_ACTION_ROUTE,
  FACTORY_BOARD_ROUTE,
  FACTORY_CREDENTIAL_ROUTE,
  FACTORY_GIT_TOKENS_ROUTE,
  FACTORY_REPOSITORIES_ROUTE,
  FACTORY_WORKSETS_ROUTE,
} from "./routes";
import { createWorksetResolver } from "./workset-session";

const NOT_WRITABLE = "start Studio with --writable to create or start Worksets";

/** Where the factory keeps the companions it cloned; the only place Studio deletes a folder. */
const DEFAULT_COMPANIONS_DIR = "/companions";

export interface FactoryStudioDeps {
  /** The broker's client; from the host's connection when absent. */
  client?: FactoryClient | null;
  /** The factory's Outcomes, built from the ports; from the environment when absent. */
  outcomes?: (portsFor: (companionPath: string) => OutcomesPorts) => FactoryOutcomes | null;
  /** A companion's Workset stages; read from OpenSpec when absent. */
  worksetStages?: (companionPath: string) => Promise<{ worksets: WorksetWithStage[] }>;
}

/** A route path below the service prefix, from its full Studio route. */
function below(route: string): string {
  return route.slice(route.indexOf("/", "/api/plugins/".length));
}

/**
 * The factory's part of Studio: the board's routes, the Agents and Git access panels, the
 * Working Repository list, run logs, Workset terminal sessions and companions by Git URL.
 * `null` without the broker's client.
 */
export function factoryStudio(
  host: StudioServiceHost,
  deps: FactoryStudioDeps = {},
): StudioServiceContribution | null {
  const socket = host.connection?.kind === "socket" ? host.connection.path : undefined;
  const client = deps.client !== undefined ? deps.client : factoryClient(socket);
  if (!client) return null;

  const stagesOf =
    deps.worksetStages ?? ((companionPath: string) => readCompanionWorksetStages(companionPath));
  const portsFor = (companionPath: string): OutcomesPorts => ({
    stages: () => stagesOf(companionPath),
    reports: {
      publish: (report) => host.reports.publish(companionPath, report),
      ids: () => host.reports.ids(companionPath),
    },
    sessions: host.terminal,
  });
  const outcomes = (() => {
    try {
      if (deps.outcomes) return deps.outcomes(portsFor);
      const companion = host.launchCompanion;
      return createFactoryOutcomes(companion, portsFor(companion ?? ""), host.env);
    } catch (error) {
      process.stderr.write(
        `mate studio: the factory runner did not start: ${errorMessage(error)}\n`,
      );
      return null;
    }
  })();
  /** A companion's Outcomes: the factory's for the companion it runs, record-only otherwise. */
  const outcomesFor = (companionPath: string): Outcomes =>
    outcomes?.companionPath === companionPath
      ? outcomes
      : recordOutcomes(companionPath, () => stagesOf(companionPath));
  if (outcomes) outcomes.onChanged(() => host.boardChanged(outcomes.companionPath));

  const companionOf = async (request: Request, fields?: Record<string, unknown>) => {
    const digest = fields ? fields.companion : new URL(request.url).searchParams.get("companion");
    return host.companionPath(typeof digest === "string" ? digest : "");
  };

  const routes: StudioRoute[] = [
    {
      path: below(FACTORY_BOARD_ROUTE),
      methods: { GET: { kind: "read" } },
      handle: async (request) => {
        try {
          const companionPath = await companionOf(request);
          const sessions = host.terminal.enabled
            ? Object.fromEntries(
                host.terminal
                  .sessions()
                  .flatMap((session) =>
                    session.workset ? [[session.workset.id, session.id]] : [],
                  ),
              )
            : null;
          return answer({ runs: await outcomesFor(companionPath).runs(), sessions });
        } catch (error) {
          return answer({ reason: errorMessage(error) }, 400);
        }
      },
    },
    {
      path: below(FACTORY_ACTION_ROUTE),
      methods: { POST: { kind: "write", writable: NOT_WRITABLE } },
      handle: async (request) => {
        try {
          const input = await body(request);
          const companionPath = await companionOf(request, input);
          const fields = (input.fields ?? {}) as Record<string, unknown>;
          const field = (name: string) =>
            typeof fields[name] === "string" ? (fields[name] as string) : "";
          const target = outcomesFor(companionPath);
          if (input.action === "create") await target.create(field);
          else await target.act(String(input.id ?? ""), input.action as never, field);
          host.boardChanged(companionPath);
          return answer({ ok: true });
        } catch (error) {
          return answer({ reason: errorMessage(error) }, 400);
        }
      },
    },
    {
      path: below(FACTORY_REPOSITORIES_ROUTE),
      methods: {
        POST: { kind: "write", writable: "start Studio with --writable to add repositories" },
        DELETE: { kind: "write", writable: "start Studio with --writable to remove repositories" },
      },
      handle: async (request) => {
        try {
          const input = await body(request);
          const companionPath = await companionOf(request, input);
          if (request.method === "DELETE") {
            const removed = await removeRepository(companionPath, String(input.identity ?? ""));
            if (removed.ok) host.boardChanged(companionPath);
            return answer(removed);
          }
          const added = await addRepository(
            companionPath,
            input.input as Parameters<typeof addRepository>[1],
            { client },
          );
          if (added.ok && !added.existing) host.boardChanged(companionPath);
          return answer(added);
        } catch (error) {
          return answer({ ok: false, reason: errorMessage(error) });
        }
      },
    },
    {
      path: below(FACTORY_CREDENTIAL_ROUTE),
      methods: {
        GET: { kind: "read" },
        PUT: {
          kind: "write",
          writable: "start Studio with --writable to set the agent credential",
        },
        DELETE: {
          kind: "write",
          writable: "start Studio with --writable to set the agent credential",
        },
      },
      handle: (request) => factoryCredentialResponse(client, request),
    },
    {
      path: below(FACTORY_GIT_TOKENS_ROUTE),
      methods: {
        GET: { kind: "read" },
        PUT: { kind: "write", writable: "start Studio with --writable to set Git tokens" },
        DELETE: { kind: "write", writable: "start Studio with --writable to set Git tokens" },
      },
      handle: (request) => factoryGitTokensResponse(client, request),
    },
    {
      path: `${below(FACTORY_WORKSETS_ROUTE)}/*`,
      methods: { GET: { kind: "read" } },
      handle: async (_request, context) => {
        const match = /^\/worksets\/([^/]+)\/log(\/stream)?$/.exec(context.path);
        const id = match ? decodeURIComponent(match[1]!) : "";
        if (!match || !outcomes || !isWorksetId(id))
          return new Response("not found", { status: 404 });
        if (match[2]) {
          context.keepOpen();
          return logStream(outcomes, id);
        }
        return new Response(await outcomes.log(id), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      },
    },
  ];

  const resolve = createWorksetResolver({
    launchTarget: (digest) => host.launchTarget(digest),
    mateCommand: host.mateCommand,
    client: () => client,
    env: host.env,
    noGit: host.noGit,
    // A person in control continues the factory's own conversation.
    takenOver: async (id) => (outcomes ? outcomes.takenOver(id) : null),
  });

  return {
    routes,
    views: [
      {
        id: "board",
        label: "Factory",
        description: "Outcomes the factory works on, and the decisions they wait for.",
      },
    ],
    worksetSessions: {
      resolve,
      // Quitting Claude in a person's session hands the Outcome back to automation.
      onExit: async (id, companionPath) => {
        // Another companion's Workset may share the id; only the factory's own returns.
        if (!outcomes || path.resolve(companionPath) !== path.resolve(outcomes.companionPath)) {
          return;
        }
        await outcomes.returnAfterExit(id);
        // A return that starts no stage settles no run; the open board still has to learn of it.
        host.boardChanged(outcomes.companionPath);
      },
    },
    companions: factoryCompanionSource(
      client,
      host.env.MATE_COMPANIONS_DIR || DEFAULT_COMPANIONS_DIR,
    ),
    pinnedCompanions: outcomes ? [outcomes.companionPath] : [],
  };
}

/**
 * A Workset's run log as it grows: one `replay` (the stored log and the text still
 * streaming), then the live events. Read-only; leaving never touches the run.
 */
function logStream(live: { watch(id: string): LiveViewer }, id: string): Response {
  const encoder = new TextEncoder();
  let viewer: LiveViewer | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": studio factory log\n\n"));
      const current = live.watch(id);
      viewer = current;
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          current.close();
        }
      };
      void (async () => {
        send({ type: "replay", ...(await current.replay) });
        // oxlint-disable-next-line no-await-in-loop -- events arrive one at a time, in order
        for (let event = await current.next(); event; event = await current.next()) send(event);
      })().catch(() => current.close());
    },
    cancel() {
      viewer?.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
