import { collectStudioInventory, type StudioInventory } from "./inventory";
import { assembleCompanionPayload, type StudioCompanionResponse } from "./payload";
import { STUDIO_HOSTNAME } from "./routes";
import { parseStudioSelection, resolveCompanion } from "./selection";
import { createStudioSnapshotCache, type StudioSnapshotCache } from "./snapshot";
import type { StudioPage } from "./views/model";
import { createVaultManager, resolveVaultPath, VaultPathError, type VaultManager } from "./vault";

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
  vault?: VaultManager;
}

export interface StudioServerOptions {
  port?: number;
  hostname?: string;
  writable?: boolean;
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface StudioFetch {
  (request: Request): Promise<Response>;
  close(): void;
}

/**
 * The studio request handler. Read endpoints are refused before collection, and
 * the vault save route is the only write path. The response is
 * already correct for the URL that asked for it — the companion, the change,
 * and the view are read from the request rather than reconciled in the browser.
 * Collection is held in one snapshot cache for the life of the handler, so a
 * navigation that only names another view of already-collected state serves it
 * without spawning OpenSpec again.
 */
export function createStudioFetch(
  deps: StudioServerDeps = {},
  options: Pick<StudioServerOptions, "writable"> = {},
): StudioFetch {
  const inventory = deps.collectStudioInventory ?? collectStudioInventory;
  const companion = deps.assembleCompanionPayload ?? assembleCompanionPayload;
  const render = deps.renderDocument ?? renderStudioDocument;
  const snapshots =
    deps.snapshots ?? createStudioSnapshotCache({ assembleCompanionPayload: companion });
  const vault = deps.vault ?? createVaultManager();
  const writable = options.writable === true;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const isSave = url.pathname === "/api/vault/save";
    if (isSave && request.method !== "POST") {
      return new Response("vault save requires POST", { status: 405, headers: { allow: "POST" } });
    }
    if (!READ_METHODS.has(request.method) && !(isSave && request.method === "POST")) {
      return new Response("studio serves read requests only", {
        status: 405,
        headers: { allow: isSave ? "POST" : "GET, HEAD" },
      });
    }

    const respond = (response: Response) =>
      request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;

    if (url.pathname === "/api/vault/tree") {
      const selected = await selectedCompanion(url, inventory);
      if (!selected) return respond(json({ reason: "no registered companion was selected" }, 400));
      try {
        return respond(
          json(await vault.tree(selected.path, url.searchParams.get("refresh") === "1")),
        );
      } catch (error) {
        return respond(
          json({ reason: error instanceof Error ? error.message : String(error) }, 400),
        );
      }
    }

    if (url.pathname === "/api/vault/file") {
      const selected = await selectedCompanion(url, inventory);
      if (!selected) return respond(json({ reason: "no registered companion was selected" }, 400));
      try {
        return respond(json(await vault.open(selected.path, url.searchParams.get("path") ?? "")));
      } catch (error) {
        return respond(
          json({ reason: error instanceof Error ? error.message : String(error) }, 400),
        );
      }
    }

    if (url.pathname === "/api/vault/events") {
      const selected = await selectedCompanion(url, inventory);
      if (!selected) return respond(json({ reason: "no registered companion was selected" }, 400));
      try {
        const opened = await resolveVaultPath(selected.path, url.searchParams.get("path") ?? "");
        return respond(vaultEvents(vault, selected.path, opened.relative));
      } catch (error) {
        return respond(
          json({ reason: error instanceof Error ? error.message : String(error) }, 400),
        );
      }
    }

    if (isSave) {
      if (!writable)
        return respond(json({ reason: "start Studio with --writable to enable saving" }, 403));
      let body: { companion?: string; path?: string; content?: string; token?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return respond(json({ reason: "save requires a JSON body" }, 400));
      }
      const selected = await selectedCompanion(
        new URL(`${url.origin}/?companion=${encodeURIComponent(body.companion ?? "")}`),
        inventory,
      );
      if (!selected || typeof body.path !== "string" || typeof body.content !== "string") {
        return respond(
          json({ reason: "save requires a registered companion, path, and content" }, 400),
        );
      }
      try {
        const result = await vault.save(selected.path, body.path, body.content, body.token);
        return respond(json(result, result.kind === "conflict" ? 409 : 200));
      } catch (error) {
        return respond(
          json(
            { reason: error instanceof Error ? error.message : String(error) },
            error instanceof VaultPathError ? 400 : 500,
          ),
        );
      }
    }

    if (url.pathname !== "/") return respond(new Response("not found", { status: 404 }));

    return respond(
      html(await render(await collectStudioPage(url, inventory, snapshots, vault, writable))),
    );
  };

  handler.close = () => vault.stop();
  return handler;
}

async function selectedCompanion(
  url: URL,
  collectInventory: () => Promise<StudioInventory>,
): Promise<ReturnType<typeof resolveCompanion>> {
  const inventory = await collectInventory();
  return resolveCompanion(inventory, parseStudioSelection(url).companionDigest);
}

function vaultEvents(vault: VaultManager, companionPath: string, requestedPath: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": studio vault events\n\n"));
      unsubscribe = vault.subscribe(companionPath, requestedPath, (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          unsubscribe();
        }
      });
    },
    cancel() {
      unsubscribe();
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

/**
 * One rendered document's worth of state. An absent or unresolvable companion
 * is not a failure: the page renders the selector and the server keeps serving.
 */
async function collectStudioPage(
  url: URL,
  collectInventory: () => Promise<StudioInventory>,
  snapshots: StudioSnapshotCache,
  vault: VaultManager,
  writable: boolean,
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
    writable,
    vault: null,
  };

  if (!companion) {
    vault.deactivate();
    return page;
  }

  if (selection.view === "vault") {
    try {
      const tree = await vault.tree(companion.path, selection.refresh);
      let open = null;
      let refusal: string | null = null;
      if (selection.openPath) {
        try {
          open = await vault.open(companion.path, selection.openPath);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        ...page,
        vault: {
          tree: tree.tree,
          open,
          refusal,
          incoming: null,
          overwritten: null,
          watching: tree.watching,
          warning: tree.warning,
        },
      };
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

  vault.deactivate();

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
 * A bind failure propagates: the caller reports it and exits rather than
 * opening a browser at a URL nothing answers.
 */
export function startStudioServer(
  deps: StudioServerDeps = {},
  options: StudioServerOptions = {},
): StudioServerHandle {
  const serve = deps.serve ?? bunServe;
  const port = options.port ?? 0;
  const hostname = options.hostname ?? STUDIO_HOSTNAME;
  const fetchHandler = createStudioFetch(deps, { writable: options.writable });
  const server = serve({ port, hostname, fetch: fetchHandler });
  const urlHostname =
    hostname === STUDIO_HOSTNAME || hostname === "localhost" || hostname === "::1"
      ? "localhost"
      : hostname.includes(":") && !hostname.startsWith("[")
        ? `[${hostname}]`
        : hostname;

  return {
    url: `http://${urlHostname}:${server.port}`,
    port: server.port,
    hostname,
    stop: async () => {
      fetchHandler.close();
      await server.stop(true);
    },
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
