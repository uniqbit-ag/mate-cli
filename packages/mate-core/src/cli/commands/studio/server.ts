import {
  createStudioAccess,
  exchangeStudioToken,
  studioAddress,
  type StudioAccess,
  type StudioInvocation,
} from "./access";
import { collectStudioInventory, type StudioInventory } from "./inventory";
import { assembleCompanionPayload, type StudioCompanionResponse } from "./payload";
import { STUDIO_HOSTNAME } from "./routes";
import { companionDigest, parseStudioSelection, resolveCompanion } from "./selection";
import { createStudioSnapshotCache, type StudioSnapshotCache } from "./snapshot";
import type { StudioPage } from "./views/model";
import { createVaultManager, resolveVaultPath, VaultPathError, type VaultManager } from "./vault";
import {
  DEFAULT_DETACH_MINUTES,
  TerminalRegistry,
  type TerminalConnection,
  type TerminalRegistryOptions,
} from "./terminal";
import { terminalAsset } from "./terminal-assets";
import {
  createLaunchResolver,
  effectiveLaunchCompanion,
  launchableAgents,
} from "./terminal-launch";

export { STUDIO_HOSTNAME } from "./routes";

/** Read methods; every other method is refused before any collection runs. */
const READ_METHODS = new Set(["GET", "HEAD"]);

/** The socket Bun hands a WebSocket handler; `data` is what the upgrade attached. */
export interface StudioSocket {
  data: { connection?: TerminalConnection };
  send(data: string | Uint8Array): number;
  getBufferedAmount(): number;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface StudioUpgrader {
  upgrade(request: Request, options: { data: StudioSocket["data"] }): boolean;
}

export interface StudioServeOptions {
  port: number;
  hostname: string;
  fetch: (request: Request, server: StudioUpgrader) => Promise<Response | undefined>;
  websocket?: {
    open(ws: StudioSocket): void;
    message(ws: StudioSocket, message: string | Uint8Array): void;
    close(ws: StudioSocket): void;
    pong(ws: StudioSocket): void;
    idleTimeout: number;
    sendPings: boolean;
    backpressureLimit: number;
    maxPayloadLength: number;
  };
}

export interface StudioBoundServer {
  port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface StudioServerHandle {
  url: string;
  /** What the operator opens: `url`, carrying the token when one was generated. */
  address: string;
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
  terminal?: Partial<TerminalRegistryOptions>;
  launchableAgents?: typeof launchableAgents;
}

export interface StudioServerOptions {
  port?: number;
  hostname?: string;
  writable?: boolean;
  invocation?: StudioInvocation;
  terminal?: boolean;
  allowedHosts?: string[];
  publicOrigin?: string | null;
  /** Operator-pinned token; generated per start when absent and Studio is guarded. */
  token?: string | null;
  detachMinutes?: number;
  /** Pins every terminal launch to this registered companion. */
  launchCompanion?: string | null;
  /** Terminal launches skip companion Git synchronization. */
  noGit?: boolean;
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

/** Answered to a tokenless document request under `serve`; carries no companion data. */
const TOKEN_REQUIRED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mate Studio</title>
<meta name="referrer" content="no-referrer"></head>
<body><main><h1>Mate Studio needs its access token</h1>
<p>Open the address Studio printed when it started; it carries <code>?token=…</code>.
If the token was pinned with <code>--token</code> or <code>MATE_STUDIO_TOKEN</code>,
open this address with <code>?token=</code> followed by that value.</p></main></body></html>`;

function refused(reason: string, status: number): Response {
  return new Response(JSON.stringify({ reason }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

const TOKEN_REASON =
  "Studio's access token is required; open the address Studio printed when it started";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface StudioFetch {
  (request: Request, server?: StudioUpgrader): Promise<Response | undefined>;
  terminal: TerminalRegistry | null;
  close(): Promise<void>;
}

export interface StudioFetchOptions extends Pick<
  StudioServerOptions,
  "writable" | "launchCompanion" | "noGit" | "detachMinutes"
> {
  access?: StudioAccess;
  /** Enables the terminal; the invocation sets its default detach window. */
  terminal?: boolean;
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
  options: StudioFetchOptions = {},
): StudioFetch {
  const inventory = deps.collectStudioInventory ?? collectStudioInventory;
  const companion = deps.assembleCompanionPayload ?? assembleCompanionPayload;
  const render = deps.renderDocument ?? renderStudioDocument;
  const snapshots =
    deps.snapshots ?? createStudioSnapshotCache({ assembleCompanionPayload: companion });
  const vault = deps.vault ?? createVaultManager();
  const writable = options.writable === true;
  const access =
    options.access ??
    createStudioAccess({
      invocation: "interactive",
      terminal: options.terminal === true,
      hostname: STUDIO_HOSTNAME,
      port: () => 80,
    });
  const launchCompanion = options.launchCompanion ?? null;
  const agentsFor = deps.launchableAgents ?? launchableAgents;
  const terminal = options.terminal
    ? new TerminalRegistry({
        detachMs: (options.detachMinutes ?? DEFAULT_DETACH_MINUTES[access.invocation]) * 60_000,
        resolveLaunch: createLaunchResolver({
          collectInventory: inventory,
          launchCompanion,
          launchableAgents: (companionPath) => agentsFor(companionPath),
        }),
        mateCommand: process.argv.slice(0, 2),
        noGit: options.noGit === true,
        ...deps.terminal,
      })
    : null;

  const handler = async (
    request: Request,
    server?: StudioUpgrader,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const acceptedOrigin = access.acceptedOrigin(request);
    if (!acceptedOrigin) return refused("Studio does not answer to this host", 421);

    const exchanged = exchangeStudioToken(request, access, acceptedOrigin);
    if (exchanged) return exchanged;

    const isSave = url.pathname === "/api/vault/save";
    const isEnd = url.pathname === "/api/terminal/sessions/end";
    const isPost = isSave || isEnd;
    if (isPost && request.method !== "POST") {
      return new Response(`${isSave ? "vault save" : "ending a session"} requires POST`, {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (!READ_METHODS.has(request.method) && !(isPost && request.method === "POST")) {
      return new Response("studio serves read requests only", {
        status: 405,
        headers: { allow: isPost ? "POST" : "GET, HEAD" },
      });
    }

    const respond = (response: Response) =>
      request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;

    if (access.requires("read") && !access.hasToken(request)) {
      if (url.pathname === "/") {
        const page = html(TOKEN_REQUIRED_PAGE);
        return respond(new Response(page.body, { status: 401, headers: page.headers }));
      }
      return respond(refused(TOKEN_REASON, 401));
    }

    if (url.pathname.startsWith("/studio/terminal/") && terminal) {
      const asset = await terminalAsset(url.pathname);
      if (asset) return respond(asset);
    }

    if (url.pathname === "/api/terminal" || url.pathname.startsWith("/api/terminal/")) {
      if (!terminal) {
        return respond(
          refused("start Studio with --writable --terminal to enable the terminal", 404),
        );
      }
      const privileged = url.pathname === "/api/terminal" || isEnd;
      if (privileged && !access.originMatches(request, acceptedOrigin)) {
        return respond(refused("the terminal is reachable only from Studio's own page", 403));
      }
      if (access.requires("terminal") && !access.hasToken(request)) {
        return respond(refused(TOKEN_REASON, 401));
      }
      if (url.pathname === "/api/terminal") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) {
          return respond(refused("the terminal is a WebSocket endpoint", 426));
        }
        if (server.upgrade(request, { data: {} })) return undefined;
        return respond(refused("the terminal connection could not be upgraded", 400));
      }
      if (url.pathname === "/api/terminal/sessions") {
        const now = Date.now();
        return respond(
          json({
            sessions: terminal.list().map((session) => ({
              id: session.id,
              agent: session.agent,
              companion: companionDigest(session.companionPath),
              companionPath: session.companionPath,
              attached: session.attached,
              ageSeconds: Math.max(0, Math.round((now - session.startedAt) / 1000)),
            })),
          }),
        );
      }
      if (isEnd) {
        let body: { id?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return respond(json({ reason: "ending a session requires a JSON body" }, 400));
        }
        if (typeof body.id !== "string" || !(await terminal.end(body.id))) {
          return respond(json({ reason: "no such session" }, 404));
        }
        return respond(json({ ended: body.id }));
      }
      return respond(new Response("not found", { status: 404 }));
    }

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
      if (!access.originMatches(request, acceptedOrigin)) {
        return respond(refused("a save must come from Studio's own page", 403));
      }
      if (access.requires("save") && !access.hasToken(request)) {
        return respond(refused(TOKEN_REASON, 401));
      }
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

    const page = await collectStudioPage(url, inventory, snapshots, vault, writable);
    if (terminal) {
      const target = await effectiveLaunchCompanion(
        page.inventory,
        launchCompanion,
        page.selection.companionDigest,
      );
      page.terminal = {
        pinned: launchCompanion !== null,
        target: target ? { path: target.path, digest: companionDigest(target.path) } : null,
        agents: target ? await agentsFor(target.path) : [],
      };
    }
    return respond(html(await render(page)));
  };

  handler.terminal = terminal;
  handler.close = async () => {
    vault.stop();
    await terminal?.stopAll();
  };
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
    terminal: null,
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
  let boundPort = port;
  const access = createStudioAccess({
    invocation: options.invocation ?? "interactive",
    terminal: options.terminal === true,
    hostname,
    port: () => boundPort,
    allowedHosts: options.allowedHosts,
    publicOrigin: options.publicOrigin,
    token: options.token,
  });
  const fetchHandler = createStudioFetch(deps, {
    writable: options.writable,
    access,
    terminal: options.terminal === true,
    detachMinutes: options.detachMinutes,
    launchCompanion: options.launchCompanion,
    noGit: options.noGit,
  });
  const registry = fetchHandler.terminal;
  const server = serve({
    port,
    hostname,
    fetch: fetchHandler,
    ...(registry
      ? {
          websocket: {
            open(ws) {
              ws.data.connection = registry.connect({
                send: (data) => void ws.send(data),
                bufferedAmount: () => ws.getBufferedAmount(),
                ping: () => ws.ping(),
                close: (code, reason) => ws.close(code, reason),
              });
            },
            message(ws, message) {
              void ws.data.connection?.message(message);
            },
            close(ws) {
              ws.data.connection?.closed();
            },
            pong(ws) {
              ws.data.connection?.pong();
            },
            idleTimeout: 0,
            sendPings: false,
            backpressureLimit: 2 * 1024 * 1024,
            maxPayloadLength: 256 * 1024,
          },
        }
      : {}),
  });
  boundPort = server.port;
  const urlHostname =
    hostname === STUDIO_HOSTNAME || hostname === "localhost" || hostname === "::1"
      ? "localhost"
      : hostname.includes(":") && !hostname.startsWith("[")
        ? `[${hostname}]`
        : hostname;

  return {
    url: `http://${urlHostname}:${server.port}`,
    address: studioAddress(hostname, server.port, options.token ? null : access.token),
    port: server.port,
    hostname,
    stop: async () => {
      await fetchHandler.close();
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
