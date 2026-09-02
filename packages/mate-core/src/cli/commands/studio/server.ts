import { collectStudioInventory, type StudioInventory } from "./inventory";
import { assembleCompanionPayload, type StudioCompanionResponse } from "./payload";
import { STUDIO_HOSTNAME } from "./routes";
import { parseStudioSelection, resolveCompanion } from "./selection";
import { createStudioSnapshotCache, type StudioSnapshotCache } from "./snapshot";
import type { StudioPage } from "./views/model";

export { STUDIO_HOSTNAME } from "./routes";

/** Read methods; every other method is refused before any collection runs. */
const READ_METHODS = new Set(["GET", "HEAD"]);

export interface StudioServeOptions {
  port: number;
  hostname: string;
  fetch: (request: Request) => Promise<Response>;
}

export interface StudioBoundServer {
  port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface StudioServerHandle {
  url: string;
  port: number;
  hostname: string;
  stop(): void | Promise<void>;
}

export interface StudioServerDeps {
  collectStudioInventory?: () => Promise<StudioInventory>;
  assembleCompanionPayload?: (companionPath: string) => Promise<StudioCompanionResponse>;
  renderDocument?: (page: StudioPage) => string | Promise<string>;
  serve?: (options: StudioServeOptions) => StudioBoundServer;
  snapshots?: StudioSnapshotCache;
}

/**
 * Loaded at the point of use so no other command pays for the renderer: `hono/jsx`
 * is reachable from the studio path alone.
 */
async function renderStudioDocument(page: StudioPage): Promise<string> {
  const views = await import("./views/document");
  return views.renderStudioDocument(page);
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The studio request handler. Read-only by construction: a non-read method is
 * refused before any collection runs, and no route writes. The response is
 * already correct for the URL that asked for it — the companion, the change,
 * and the view are read from the request rather than reconciled in the browser.
 * Collection is held in one snapshot cache for the life of the handler, so a
 * navigation that only names another view of already-collected state serves it
 * without spawning OpenSpec again.
 */
export function createStudioFetch(
  deps: StudioServerDeps = {},
): (request: Request) => Promise<Response> {
  const inventory = deps.collectStudioInventory ?? collectStudioInventory;
  const companion = deps.assembleCompanionPayload ?? assembleCompanionPayload;
  const render = deps.renderDocument ?? renderStudioDocument;
  const snapshots =
    deps.snapshots ?? createStudioSnapshotCache({ assembleCompanionPayload: companion });

  return async (request: Request): Promise<Response> => {
    if (!READ_METHODS.has(request.method)) {
      return new Response("studio serves read requests only", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);
    const respond = (response: Response) =>
      request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;

    if (url.pathname !== "/") return respond(new Response("not found", { status: 404 }));

    return respond(html(await render(await collectStudioPage(url, inventory, snapshots))));
  };
}

/**
 * One rendered document's worth of state. An absent or unresolvable companion
 * is not a failure: the page renders the selector and the server keeps serving.
 */
async function collectStudioPage(
  url: URL,
  collectInventory: () => Promise<StudioInventory>,
  snapshots: StudioSnapshotCache,
): Promise<StudioPage> {
  const selection = parseStudioSelection(url);
  const inventory = await collectInventory();
  const companion = resolveCompanion(inventory, selection.companionDigest);
  const page: StudioPage = {
    inventory,
    selection,
    companion,
    payload: null,
    error: null,
    collectedAt: null,
  };

  if (!companion) return page;

  try {
    const snapshot = await snapshots.read(companion.path, selection.refresh);
    const collected = { ...page, collectedAt: snapshot.collectedAt };
    if ("error" in snapshot.response) return { ...collected, error: snapshot.response.error };
    return { ...collected, payload: snapshot.response };
  } catch (error) {
    return {
      ...page,
      error: {
        companionPath: companion.path,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Bun's server, reached through `globalThis` rather than an ambient global: the
 * repository typechecks against Node types only, and Studio's dependence on the
 * Bun runtime is a deliberate constraint worth naming here.
 */
interface BunRuntime {
  serve(options: StudioServeOptions): StudioBoundServer;
}

function bunServe(options: StudioServeOptions): StudioBoundServer {
  const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!runtime) throw new Error("studio requires the Bun runtime to serve");
  return runtime.serve(options);
}

/**
 * Binds the studio server to an operating-system-assigned loopback port. A
 * bind failure propagates: the caller reports it and exits rather than opening
 * a browser at a URL nothing answers.
 */
export function startStudioServer(deps: StudioServerDeps = {}): StudioServerHandle {
  const serve = deps.serve ?? bunServe;
  const server = serve({ port: 0, hostname: STUDIO_HOSTNAME, fetch: createStudioFetch(deps) });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    hostname: STUDIO_HOSTNAME,
    stop: () => server.stop(true),
  };
}

export interface ServeUntilInterruptedDeps {
  onSignal?: (signal: string, handler: () => void) => () => void;
}

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function subscribeToProcessSignal(signal: string, handler: () => void): () => void {
  process.on(signal as NodeJS.Signals, handler);
  return () => process.off(signal as NodeJS.Signals, handler);
}

/**
 * Holds the invocation open while the server serves, and stops it on the first
 * interrupt. Nothing outlives the invocation: no detached process, no
 * process-identifier file, no registration, and the signal handlers are removed
 * before the promise settles.
 */
export function serveUntilInterrupted(
  server: StudioServerHandle,
  deps: ServeUntilInterruptedDeps = {},
): Promise<void> {
  const onSignal = deps.onSignal ?? subscribeToProcessSignal;

  return new Promise<void>((resolve) => {
    const unsubscribes: (() => void)[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      void Promise.resolve(server.stop()).then(resolve, resolve);
    };

    for (const signal of INTERRUPT_SIGNALS) {
      unsubscribes.push(onSignal(signal, finish));
    }
  });
}
