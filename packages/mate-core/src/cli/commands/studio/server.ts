import {
  createStudioAccess,
  exchangeStudioToken,
  normalizeOrigin,
  readBearer,
  studioAddress,
  type StudioAccess,
  type StudioInvocation,
} from "./access";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { MERMAID_RUNTIME_URL } from "../report/renderer";
import {
  CompanionRemovalError,
  deletableWithin,
  deleteRegisteredCompanion,
} from "./companion-removal";
import { collectStudioInventory, type StudioInventory } from "./inventory";
import { assembleCompanionPayload, type StudioCompanionResponse } from "./payload";
import { createReportStore, isReportId, REPORT_LIMITS, type ReportStore } from "./reports";
import { WorksetError } from "../../../lib/workset/record";
import type { PluginService, StudioSocketHandler } from "../../../tools/setup/service";
import { registeredServices } from "../../../tools/setup/service-registry";
import { addCompanionByPath, addCompanionByUrl } from "./companion-add";
import { LiveSessions } from "./live-sessions";
import {
  guardedSocket,
  type MatchedServiceRoute,
  mountStudioServices,
  type MountedServices,
  NO_SERVICES,
} from "./service-host";
import {
  REPORTS_ROUTE,
  REPORT_VIEW_PREFIX,
  SERVICE_ASSET_PREFIX,
  SERVICE_ROUTE_PREFIX,
  STUDIO_EVENTS_ROUTE,
  STUDIO_HOSTNAME,
  STUDIO_PING_ROUTE,
  type StudioEvent,
  TERMINAL_ASSET_PREFIX,
  TERMINAL_SESSIONS_END_ROUTE,
  TERMINAL_SESSIONS_ROUTE,
  TERMINAL_SOCKET_ROUTE,
  VAULT_EVENTS_ROUTE,
} from "./routes";
import {
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  companionDigest,
  modePolicy,
  parse,
  parseVaultSelection,
  REFRESH_PARAM,
  resolveCompanion,
  type StudioModePolicy,
  type StudioProfile,
} from "./selection";
import { errorMessage } from "../../../runtime/error-message";
import type { SpecGraphCache } from "./graph";
import { createStudioSnapshotCache, type StudioSnapshotCache } from "./snapshot";
import type { StudioPage } from "./views/model";
import { createVaultManager, resolveVaultPath, VaultPathError, type VaultManager } from "./vault";
import {
  DEFAULT_DETACH_MINUTES,
  TerminalRegistry,
  type TerminalConnection,
  type TerminalRegistryOptions,
} from "./terminal";
import type { StudioServices } from "./services";
import type { UsageCache } from "../../../lib/usage/cache";
import { reserveManualLaunch } from "../../../lib/workset/execution";
import { createWorkServices } from "./work";
import { studioAppAsset, type StudioApp } from "./studio-app";
import { terminalAsset } from "./terminal-assets";
import {
  createLaunchResolver,
  effectiveLaunchCompanion,
  launchableAgents,
} from "./terminal-launch";

export { STUDIO_HOSTNAME } from "./routes";

/** Where Start's server functions are called; the only POSTs the application makes. */
const STUDIO_APP_CALL_PREFIX = "/_serverFn/";

/** The socket Bun hands a WebSocket handler; `data` is what the upgrade attached. */
export interface StudioSocket {
  /** A terminal connection, or a service's socket. */
  data: { connection?: TerminalConnection; service?: StudioSocketHandler };
  send(data: string | Uint8Array): number;
  getBufferedAmount(): number;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface StudioUpgrader {
  upgrade(request: Request, options: { data: StudioSocket["data"] }): boolean;
  /** Per-request idle timeout in seconds; `0` disables it. */
  timeout?(request: Request, seconds: number): void;
}

/** Bun's maximum; its 10 s default cut slow Vault listings into empty responses. */
export const STUDIO_IDLE_TIMEOUT_SECONDS = 255;

export interface StudioServeOptions {
  port: number;
  hostname: string;
  idleTimeout: number;
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
  serve?: (options: StudioServeOptions) => StudioBoundServer;
  snapshots?: StudioSnapshotCache;
  vault?: VaultManager;
  reports?: ReportStore;
  usage?: UsageCache;
  /** Where the Friction Log and Switch live; the user's home when absent. */
  homeDir?: string;
  terminal?: Partial<TerminalRegistryOptions>;
  launchableAgents?: typeof launchableAgents;
  /** The plugin services Studio mounts; the registered plugins' when absent. */
  services?: readonly PluginService[];
  /** The environment services read their connection from; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
}

export interface StudioServerOptions {
  port?: number;
  hostname?: string;
  writable?: boolean;
  invocation?: StudioInvocation;
  terminal?: boolean;
  allowedHosts?: string[];
  publicOrigin?: string | null;
  /** Operator-pinned token; generated per start when absent. */
  token?: string | null;
  detachMinutes?: number;
  /** Pins every terminal launch to this registered companion. */
  launchCompanion?: string | null;
  /** Seconds; defaults to `STUDIO_IDLE_TIMEOUT_SECONDS`. */
  idleTimeout?: number;
  /** Terminal launches skip companion Git synchronization. */
  noGit?: boolean;
  /** Which Studio modes are enabled; `standard` when absent. Never read from a request. */
  profile?: StudioProfile;
  /** Studio's built application, loaded by the studio command. */
  app?: StudioApp | null;
}

/** Answered to a document request when no Studio build is installed; carries no companion data. */
const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mate Studio</title></head>
<body><p>Studio's application build is missing. Run <code>bun run build</code> in <code>packages/mate-studio</code>, then reload.</p></body>
</html>
`;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
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

/**
 * What a route is, for its guard. A read needs the token where the invocation requires it
 * for reading; a write also needs the same origin, the token for saving and, when it names
 * a reason, the write path; a terminal call needs the token for the terminal and, when
 * privileged, the same origin; a session call is checked by its own bearer credential only.
 */
type RouteKind =
  | { kind: "read"; methods: readonly string[] }
  | { kind: "write"; methods: readonly string[]; writable?: string }
  | { kind: "terminal"; methods: readonly string[]; privileged: boolean }
  | { kind: "session"; methods: readonly string[] };

const ORIGIN_REASON = {
  write: "a change must come from Studio's own page",
  terminal: "the terminal is reachable only from Studio's own page",
} as const;

const READS = ["GET", "HEAD"] as const;

/** A service route by the access its method declares; a WebSocket is guarded like a write. */
function serviceRouteKind(matched: MatchedServiceRoute, method: string): RouteKind {
  const access = matched.access;
  if (!access) return { kind: "read", methods: matched.methods };
  if (access.kind === "read") return { kind: "read", methods: [method] };
  if (access.kind === "socket") return { kind: "write", methods: [method] };
  return {
    kind: "write",
    methods: [method],
    ...(access.writable ? { writable: access.writable } : {}),
  };
}

/** Every route core answers, by kind; the rest are reads the application answers. */
function routeOf(
  url: URL,
  method: string,
  hasApp: boolean,
  service: MatchedServiceRoute | null,
): RouteKind {
  const { pathname } = url;
  if (pathname === REPORTS_ROUTE && method === "POST")
    return { kind: "session", methods: ["POST"] };
  if (service) return serviceRouteKind(service, method);
  // A service that is not mounted answers nothing, whatever the method.
  if (pathname.startsWith(SERVICE_ROUTE_PREFIX)) return { kind: "read", methods: [method] };
  if (pathname === TERMINAL_SOCKET_ROUTE) {
    return { kind: "terminal", methods: READS, privileged: true };
  }
  if (pathname === TERMINAL_SESSIONS_END_ROUTE) {
    return { kind: "terminal", methods: ["POST"], privileged: true };
  }
  if (pathname.startsWith(`${TERMINAL_SOCKET_ROUTE}/`)) {
    return { kind: "terminal", methods: READS, privileged: false };
  }
  // A server function is a read when called with GET and a write when called with POST; the
  // write path for its changes is checked by the services it calls.
  if (hasApp && pathname.startsWith(STUDIO_APP_CALL_PREFIX) && method === "POST") {
    return { kind: "write", methods: ["POST"] };
  }
  return { kind: "read", methods: READS };
}

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

/**
 * Sent with every hosted report: opaque origin, no Studio cookie or storage, and
 * no connections beyond the one pinned, integrity-checked diagram runtime.
 */
const REPORT_CSP = [
  "sandbox allow-scripts allow-modals",
  "default-src 'none'",
  `script-src 'unsafe-inline' ${MERMAID_RUNTIME_URL}`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
].join("; ");

/** A published report as open pages are told of it; carries no path and no content. */
interface PublishedReport {
  id: string;
  title: string;
}

/**
 * The body as text, or `null` over `limit`. An oversized body is drained unparsed
 * and unbuffered (up to a hard bound): answering before the client finished
 * sending wedges its keep-alive connection.
 */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const declared = Number(request.headers.get("content-length"));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = Number.isFinite(declared) && declared > limit;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks arrive in order
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) over = true;
    if (over) {
      chunks.length = 0;
      if (size > limit * 4) {
        // oxlint-disable-next-line no-await-in-loop -- same stream
        await reader.cancel();
        break;
      }
    } else {
      chunks.push(value);
    }
  }
  return over ? null : Buffer.concat(chunks).toString("utf8");
}

const TOKEN_REASON =
  "Studio's access token is required; open the address Studio printed when it started";

const NO_COMPANION = "no registered companion was selected";

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface StudioFetch {
  (request: Request, server?: StudioUpgrader): Promise<Response | undefined>;
  terminal: TerminalRegistry | null;
  services: StudioServices;
  /** Settles once every plugin service is mounted. */
  ready: Promise<MountedServices>;
  close(): Promise<void>;
}

export interface StudioFetchOptions extends Pick<
  StudioServerOptions,
  "writable" | "launchCompanion" | "noGit" | "detachMinutes" | "profile"
> {
  access?: StudioAccess;
  /** Loopback origin the terminal's processes publish to; read at spawn. */
  reportOrigin?: () => string | null;
  /** The only origin an absolute report URL is built from. */
  publicOrigin?: string | null;
  /** Enables the terminal; the invocation sets its default detach window. */
  terminal?: boolean;
  /** Studio's built application; paths the handler does not serve itself go to it. */
  app?: StudioApp | null;
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
  const snapshots =
    deps.snapshots ?? createStudioSnapshotCache({ assembleCompanionPayload: companion });
  const vault = deps.vault ?? createVaultManager();
  /** Created on the first Graph request, so other views never load the graph index. */
  let graphs: Promise<SpecGraphCache> | null = null;
  const writable = options.writable === true;
  const policy = modePolicy(options.profile ?? "standard");
  const reports = deps.reports ?? createReportStore();
  const env = deps.env ?? process.env;
  // Created before the terminal and the services, so neither needs the other.
  const sessions = new LiveSessions();
  const launchCompanion = options.launchCompanion ?? null;
  /** The mounted services; none until they are, and every request waits for them. */
  let services: MountedServices = NO_SERVICES;
  const access =
    options.access ??
    createStudioAccess({
      invocation: "interactive",
      terminal: options.terminal === true,
      hostname: STUDIO_HOSTNAME,
      port: () => 80,
    });
  void reports.cleanup().catch(() => {});
  const publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : null;
  const reportListeners = new Map<string, Set<(event: PublishedReport) => void>>();
  const agentsFor = deps.launchableAgents ?? launchableAgents;
  const terminal: TerminalRegistry | null = options.terminal
    ? new TerminalRegistry({
        detachMs: (options.detachMinutes ?? DEFAULT_DETACH_MINUTES[access.invocation]) * 60_000,
        resolveLaunch: createLaunchResolver({
          collectInventory: inventory,
          launchCompanion,
          launchableAgents: (companionPath) => agentsFor(companionPath),
          // Work starts from the terminal pass the same start guard; read-only Studio has none.
          ...(writable
            ? {
                reserveWork: (companionPath, action, subject) =>
                  reserveManualLaunch(companionPath, {
                    kind: action.subject === "change" ? "change" : "workset",
                    name: subject,
                  }),
              }
            : {}),
        }),
        mateCommand: process.argv.slice(0, 2),
        sessions,
        resolveWorkset: async (id, digest, sessionId) =>
          (await ready).worksetSessions?.resolve(id, digest, sessionId) ?? {
            reason: "no service of this Studio starts Workset sessions",
          },
        onWorksetExit: async (id, companionPath) =>
          (await ready).worksetSessions?.onExit?.(id, companionPath),
        noGit: options.noGit === true,
        reportUrl: options.reportOrigin,
        ...deps.terminal,
      })
    : null;
  /** Stores a report for the live terminal session holding the bearer credential. */
  const publishReport = async (request: Request): Promise<Response> => {
    const token = readBearer(request);
    const companionPath = token ? (terminal?.reportCompanion(token) ?? null) : null;
    if (!companionPath) return refused("a live Studio session's credential is required", 401);
    const raw = await readCapped(request, REPORT_LIMITS.uploadBytes);
    if (raw === null) return json({ reason: "the report exceeds the size limit" }, 413);
    let body: { title?: unknown; html?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json({ reason: "publishing requires a JSON body" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.title !== "string" ||
      typeof body.html !== "string" ||
      !body.html
    ) {
      return json({ reason: "a report needs a string title and html" }, 400);
    }
    const digest = companionDigest(companionPath);
    const stored = await reports.publish(digest, {
      title: body.title.slice(0, 200),
      html: body.html,
    });
    for (const notify of reportListeners.get(digest) ?? []) {
      notify({ id: stored.id, title: stored.title });
    }
    const viewPath = `${REPORT_VIEW_PREFIX}${stored.id}`;
    return json({
      id: stored.id,
      path: viewPath,
      ...(publicOrigin ? { url: `${publicOrigin}${viewPath}` } : {}),
    });
  };

  /** One document's model, with the terminal state its address needs. */
  const collectPage = async (url: URL): Promise<StudioPage> => {
    const page = await collectStudioPage(url, policy, inventory, snapshots, writable);
    page.renderedAt = Date.now();
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
    return page;
  };

  /** A registered companion by digest, or a refusal the caller reports. */
  const companionPathOf = async (digest: string): Promise<string> => {
    const selected = await selectedCompanion(digest || null, inventory);
    if (!selected) throw new WorksetError(NO_COMPANION);
    return selected.path;
  };

  /** Viewers of a companion's board, by digest; told when an Outcome or run changes. */
  const boardListeners = new Map<string, Set<() => void>>();
  const boardChanged = (digest: string) => {
    for (const notify of boardListeners.get(digest) ?? []) notify();
  };

  const ready: Promise<MountedServices> = mountStudioServices(
    deps.services ?? registeredServices(),
    {
      writable,
      noGit: options.noGit === true,
      launchCompanion,
      mateCommand: process.argv.slice(0, 2),
      env,
      companionPath: companionPathOf,
      companionSnapshot: async (digest, { refresh = false } = {}) => {
        await companionPathOf(digest);
        const url = new URL("http://studio.local/");
        url.searchParams.set(COMPANION_PARAM, digest);
        if (refresh) url.searchParams.set(REFRESH_PARAM, "1");
        const page = await collectPage(url);
        return {
          payload: page.payload,
          error: page.error?.reason ?? null,
          collectedAt: page.collectedAt,
        };
      },
      companionDigest,
      launchTarget: async (digest) =>
        (await effectiveLaunchCompanion(await inventory(), launchCompanion, digest))?.path ?? null,
      boardChanged: (companionPath) => boardChanged(companionDigest(companionPath)),
      reports: {
        publish: (companionPath, report) => reports.publish(companionDigest(companionPath), report),
        ids: async (companionPath) =>
          (await reports.list(companionDigest(companionPath))).map((report) => report.id),
      },
      terminal: {
        enabled: terminal !== null,
        sessions: () =>
          (terminal?.list() ?? []).map((session) => ({
            id: session.id,
            companionPath: session.companionPath,
            ...(session.workset ? { workset: session.workset } : {}),
          })),
        busy: () => sessions.busy(),
        onEnded: (listener) => sessions.onEnded(listener),
        close: (companionPath, worksetId, reason) =>
          sessions.close(companionPath, worksetId, reason),
      },
    },
  ).then((mounted) => {
    services = mounted;
    return mounted;
  });

  /** A service route called from inside Studio: the route's `writable` refusal applies. */
  const callService = async (request: Request): Promise<Response> => {
    const current = await ready;
    const url = new URL(request.url);
    const matched = current.match(url.pathname, request.method);
    if (!matched?.route.handle) return notFound();
    const guard = matched.access;
    if (!guard || guard.kind === "socket") {
      return new Response(`${request.method} is not served here`, { status: 405 });
    }
    if (guard.kind === "write" && guard.writable && !writable) {
      return refused(guard.writable, 403);
    }
    return matched.route.handle(request, { path: matched.path, url, keepOpen: () => {} });
  };

  let usage: Promise<UsageCache> | undefined = deps.usage && Promise.resolve(deps.usage);
  const work = createWorkServices({
    writable,
    inputFor: async (companionPath, refresh = false) => {
      const url = new URL("http://studio.local/");
      url.searchParams.set(COMPANION_PARAM, companionDigest(companionPath));
      // The snapshot, as every view reads it; Git facts are read fresh regardless.
      if (refresh) url.searchParams.set(REFRESH_PARAM, "1");
      const page = await collectPage(url);
      const payload = page.payload;
      const targeted = page.terminal?.target?.path === companionPath;
      return {
        changes: payload?.changes ?? [],
        shipped: payload?.shipped ?? [],
        ...(payload?.skillInventory ? { skills: payload.skillInventory } : {}),
        terminalAgents: targeted ? (page.terminal?.agents ?? []) : [],
        linkedRepositories: payload?.linkedRepositories ?? [],
        ...(payload?.ticketFormat ? { ticketFormat: payload.ticketFormat } : {}),
      };
    },
  });

  const studioServices: StudioServices = {
    writable,
    services: () => services.summaries(),
    keepsFolder: (companionPath) => {
      const folder = services.companions?.folder;
      return folder !== undefined && !deletableWithin(companionPath, folder);
    },
    addsCompanions: () => services.companions !== null,
    modePolicy: policy,
    page: collectPage,
    callService,
    work: async (digest) => work.work(await companionPathOf(digest)),
    workAction: async (digest, request) => {
      const result = await work.act(await companionPathOf(digest), request);
      if (result.ok && request.action !== "share-preview") boardChanged(digest);
      return result;
    },
    vault: async (digest, request) => {
      const { vaultView } = await import("./views/vault/view");
      return vaultView(vault, await companionPathOf(digest), request);
    },
    vaultChildren: async (digest, dir) => {
      const { vaultChildren } = await import("./views/vault/view");
      return vaultChildren(vault, await companionPathOf(digest), dir);
    },
    vaultMatches: async (digest, query) => {
      const { vaultMatches } = await import("./views/vault/view");
      return vaultMatches(vault, await companionPathOf(digest), query);
    },
    vaultPreview: async (digest, filePath, content) => {
      await companionPathOf(digest);
      const { markdownTree } = await import("./views/vault/markdown-tree");
      return markdownTree(content, filePath);
    },
    vaultSave: async (digest, filePath, content, token) => {
      if (!writable) throw new VaultPathError("start Studio with --writable to enable saving");
      return vault.save(await companionPathOf(digest), filePath, content, token);
    },
    graph: async (digest) => {
      const companionPath = await companionPathOf(digest);
      graphs ??= import("./graph").then(({ createSpecGraphCache }) => createSpecGraphCache());
      return (await graphs).read(companionPath);
    },
    reports: async (digest) => {
      await companionPathOf(digest);
      return reports.list(digest);
    },
    usage: async (digest, request) => {
      const companionPath = await companionPathOf(digest);
      // A failed load is forgotten so Refresh can retry it.
      usage ??= import("../../../lib/usage/cache")
        .then(({ createUsageCache }) => createUsageCache())
        .catch((error: unknown) => {
          usage = undefined;
          throw error;
        });
      return (await usage).read(companionPath, request);
    },
    friction: async (digest, { days }) => {
      const companionPath = await companionPathOf(digest);
      const { readFrictionView } = await import("../../../lib/friction/view/read");
      return readFrictionView({ companion: companionPath }, { days, homeDir: deps.homeDir });
    },
    frictionRecording: async () => {
      const { readFrictionSwitch } = await import("../../../runtime/friction-switch");
      return { recording: readFrictionSwitch(deps.homeDir) };
    },
    setFrictionRecording: async (recording) => {
      const { writeFrictionSwitch } = await import("../../../runtime/friction-switch");
      writeFrictionSwitch(recording, deps.homeDir);
      return { recording };
    },
    markFriction: async (target, state, { note, link }) => {
      const { markFriction } = await import("../../../lib/friction/mark");
      const marked = await markFriction(
        target,
        state,
        { note, link, by: "studio" },
        { homeDir: deps.homeDir },
      );
      return marked.ok ? { ok: true, state: marked.state } : { ok: false, reason: marked.reason };
    },
    skillPreview: async (digest, agent, name, file) => {
      const { readSkillPreview } = await import("./skill-files");
      return readSkillPreview(await companionPathOf(digest), agent, name, file);
    },
    deleteCompanion: async (digest) => {
      if (!writable) {
        throw new CompanionRemovalError("start Studio with --writable to delete companions");
      }
      const companionPath = await companionPathOf(digest);
      const mounted = await ready;
      const pinned = [launchCompanion, ...mounted.pinnedCompanions()].filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      );
      // Real paths, so a symlinked start path still protects its folder.
      const target = await realOrResolved(companionPath);
      const pinnedReal = await Promise.all(pinned.map((entry) => realOrResolved(entry)));
      if (pinnedReal.includes(target)) {
        throw new CompanionRemovalError(
          "Studio was started for this companion; it is not deleted.",
        );
      }
      // With a companion source, only a folder in its directory is deleted.
      const folder = mounted.companions?.folder;
      const { deletedFolder } = await deleteRegisteredCompanion(
        companionPath,
        folder === undefined ? {} : { deleteWithin: folder },
      );
      return { deletedFolder };
    },
    addCompanion: async (input) => {
      if (!writable) return { ok: false, reason: "start Studio with --writable to add companions" };
      const source = (await ready).companions;
      if (source === null) {
        return { ok: false, reason: "adding companions needs a service that provides them" };
      }
      const added =
        input.kind === "url"
          ? await addCompanionByUrl(input.url, { source })
          : await addCompanionByPath(input.path, {});
      return added.ok
        ? { ok: true, digest: companionDigest(added.companionPath), existing: added.existing }
        : added;
    },
  };
  const app = options.app ?? null;

  /** The route's refusal under its kind, decided once before it acts (design D4); `null` lets it act. */
  const refusalFor = (
    route: Exclude<RouteKind, { kind: "session" }>,
    request: Request,
    url: URL,
    acceptedOrigin: string,
  ): Response | null => {
    if (access.requires("read") && !access.hasToken(request)) {
      if (url.pathname !== "/") return refused(TOKEN_REASON, 401);
      return html(TOKEN_REQUIRED_PAGE, 401);
    }
    if (route.kind === "read") return null;
    if (route.kind === "terminal" && !terminal) {
      return refused("start Studio with --writable --terminal to enable the terminal", 404);
    }
    const privileged = route.kind === "write" || route.privileged;
    if (privileged && !access.originMatches(request, acceptedOrigin)) {
      return refused(ORIGIN_REASON[route.kind], 403);
    }
    if (
      access.requires(route.kind === "write" ? "save" : "terminal") &&
      !access.hasToken(request)
    ) {
      return refused(TOKEN_REASON, 401);
    }
    if (route.kind === "write" && route.writable && !writable) {
      return refused(route.writable, 403);
    }
    return null;
  };

  const dispatch = async (
    request: Request,
    server?: StudioUpgrader,
  ): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const acceptedOrigin = access.acceptedOrigin(request);
    if (!acceptedOrigin) return refused("Studio does not answer to this host", 421);

    const exchanged = exchangeStudioToken(request, access, acceptedOrigin);
    if (exchanged) return exchanged;

    await ready;
    const serviceRoute = services.match(url.pathname, request.method);
    const route = routeOf(url, request.method, app !== null, serviceRoute);
    if (!route.methods.includes(request.method)) {
      return new Response(`${request.method} is not served here`, {
        status: 405,
        headers: { allow: route.methods.join(", ") },
      });
    }

    const respond = (response: Response) =>
      request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;

    if (route.kind === "session") return publishReport(request);
    const refusal = refusalFor(route, request, url, acceptedOrigin);
    if (refusal) return respond(refusal);

    if (url.pathname === STUDIO_PING_ROUTE) {
      return respond(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }));
    }

    if (url.pathname === REPORTS_ROUTE) {
      const digest = url.searchParams.get(COMPANION_PARAM) ?? "";
      if (!COMPANION_DIGEST_PATTERN.test(digest)) {
        return respond(json({ reason: NO_COMPANION }, 400));
      }
      return respond(json({ reports: await reports.list(digest) }));
    }

    if (url.pathname.startsWith(REPORT_VIEW_PREFIX)) {
      const id = url.pathname.slice(REPORT_VIEW_PREFIX.length);
      const stored = isReportId(id) ? await reports.read(id) : null;
      if (stored === null) return respond(notFound());
      return respond(
        new Response(stored, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": REPORT_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        }),
      );
    }

    if (serviceRoute?.access) {
      const context = {
        path: serviceRoute.path,
        url,
        keepOpen: () => server?.timeout?.(request, 0),
      };
      if (serviceRoute.access.kind === "socket") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) {
          return respond(refused("this route is a WebSocket endpoint", 426));
        }
        const handler = serviceRoute.route.socket?.(request, context) ?? null;
        if (!handler) return respond(refused("the service refused the connection", 403));
        const service = guardedSocket(handler, (message) =>
          process.stderr.write(`mate studio: ${message}\n`),
        );
        if (server.upgrade(request, { data: { service } })) return undefined;
        return respond(refused("the connection could not be upgraded", 400));
      }
      if (!serviceRoute.route.handle) return respond(notFound());
      return respond(await serviceRoute.route.handle(request, context));
    }

    if (url.pathname.startsWith(SERVICE_ROUTE_PREFIX)) return respond(notFound());

    if (url.pathname.startsWith(SERVICE_ASSET_PREFIX)) {
      return respond((await services.asset(url.pathname)) ?? notFound());
    }

    if (app) {
      const asset = await studioAppAsset(app, url.pathname);
      if (asset) return respond(asset);
    }

    // The terminal's asset prefix is core's own, with or without the terminal.
    if (url.pathname.startsWith(TERMINAL_ASSET_PREFIX)) {
      const asset = terminal ? await terminalAsset(url.pathname) : null;
      return respond(asset ?? notFound());
    }

    if (route.kind === "terminal" && terminal) {
      if (url.pathname === TERMINAL_SOCKET_ROUTE) {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) {
          return respond(refused("the terminal is a WebSocket endpoint", 426));
        }
        if (server.upgrade(request, { data: {} })) return undefined;
        return respond(refused("the terminal connection could not be upgraded", 400));
      }
      if (url.pathname === TERMINAL_SESSIONS_ROUTE) {
        const now = Date.now();
        return respond(
          json({
            sessions: terminal.list().map((session) => ({
              id: session.id,
              agent: session.agent,
              companion: companionDigest(session.companionPath),
              companionPath: session.companionPath,
              attached: session.attached,
              ...(session.workset ? { workset: session.workset } : {}),
              ageSeconds: Math.max(0, Math.round((now - session.startedAt) / 1000)),
            })),
          }),
        );
      }
      if (url.pathname === TERMINAL_SESSIONS_END_ROUTE) {
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
      return respond(notFound());
    }

    if (url.pathname === STUDIO_EVENTS_ROUTE) {
      const digest = url.searchParams.get(COMPANION_PARAM) ?? "";
      const selected = await selectedCompanion(digest || null, inventory);
      if (!selected) return respond(json({ reason: NO_COMPANION }, 400));
      server?.timeout?.(request, 0);
      return respond(studioEvents(vault, selected.path, boardListeners, reportListeners));
    }

    if (url.pathname === VAULT_EVENTS_ROUTE) {
      const selection = parseVaultSelection(url, policy);
      const selected = await selectedCompanion(selection.companionDigest, inventory);
      if (!selected) return respond(json({ reason: NO_COMPANION }, 400));
      try {
        const opened = await resolveVaultPath(selected.path, selection.openPath ?? "");
        server?.timeout?.(request, 0);
        return respond(vaultEvents(vault, selected.path, opened.relative));
      } catch (error) {
        return respond(json({ reason: errorMessage(error) }, 400));
      }
    }

    // Everything else is the application's: its documents, views and server functions.
    if (app) return respond(await app.fetch(request, { context: { studio: studioServices } }));
    if (url.pathname === "/") return respond(html(MISSING_BUILD_PAGE));
    return respond(notFound());
  };

  // One place for every response, so refusals and the app's documents cannot miss it.
  const handler = async (
    request: Request,
    server?: StudioUpgrader,
  ): Promise<Response | undefined> => {
    const response = await dispatch(request, server);
    if (!response || new URL(request.url).pathname.startsWith(REPORT_VIEW_PREFIX)) return response;
    return forbidFraming(response);
  };

  handler.terminal = terminal;
  handler.services = studioServices;
  handler.ready = ready;
  handler.close = async () => {
    vault.stop();
    await terminal?.stopAll();
    await (await ready).close();
  };
  return handler;
}

/** A copy, because an app response such as `Response.redirect` has immutable headers. */
function forbidFraming(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-frame-options", "DENY");
  const policy = headers.get("content-security-policy")?.replace(/[;\s]+$/, "");
  headers.set(
    "content-security-policy",
    policy ? `${policy}; frame-ancestors 'none'` : "frame-ancestors 'none'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function selectedCompanion(
  digest: string | null,
  collectInventory: () => Promise<StudioInventory>,
): Promise<ReturnType<typeof resolveCompanion>> {
  return resolveCompanion(await collectInventory(), digest);
}

function realOrResolved(entry: string): Promise<string> {
  return realpath(entry).catch(() => path.resolve(entry));
}

/** Server-sent events: `subscribe` gets a send function and returns its unsubscribe. */
function eventStream(
  greeting: string,
  subscribe: (send: (event: unknown) => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: ${greeting}\n\n`));
      unsubscribe = subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          unsubscribe?.();
        }
      });
    },
    cancel() {
      unsubscribe?.();
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

/** One stream per page, so a view updates in place instead of reloading (design D7). */
function studioEvents(
  vault: VaultManager,
  companionPath: string,
  boards: Map<string, Set<() => void>>,
  reports: Map<string, Set<(event: PublishedReport) => void>>,
): Response {
  const digest = companionDigest(companionPath);
  const join = <T>(map: Map<string, Set<T>>, listener: T) => {
    const set = map.get(digest) ?? new Set<T>();
    set.add(listener);
    map.set(digest, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) map.delete(digest);
    };
  };
  return eventStream("studio events", (send: (event: StudioEvent) => void) => {
    const leaveBoard = join(boards, () => send({ type: "board" }));
    const leaveReports = join(reports, (report) =>
      send({ type: "reports", id: report.id, title: report.title }),
    );
    const stopTree = vault.subscribeTree(companionPath, (generation) =>
      send({ type: "vault-tree", generation }),
    );
    return () => {
      leaveBoard();
      leaveReports();
      stopTree();
    };
  });
}

function vaultEvents(vault: VaultManager, companionPath: string, requestedPath: string): Response {
  return eventStream("studio vault events", (send) =>
    vault.subscribe(companionPath, requestedPath, send),
  );
}

/**
 * One rendered document's worth of state. An absent or unresolvable companion
 * is not a failure: the page renders the selector and the server keeps serving.
 */
async function collectStudioPage(
  url: URL,
  policy: StudioModePolicy,
  collectInventory: () => Promise<StudioInventory>,
  snapshots: StudioSnapshotCache,
  writable: boolean,
): Promise<StudioPage> {
  const selection = parse(url, policy);
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
        reason: errorMessage(error),
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

/** An IPv6 literal in brackets, as a URL needs it; any other host as it is. */
function urlHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

/** Where a process on this host reaches the server: loopback for wildcard binds. */
function reportOrigin(hostname: string, port: number): string {
  const wildcard = hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
  return `http://${wildcard ? "127.0.0.1" : urlHost(hostname)}:${port}`;
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
    publicOrigin: options.publicOrigin,
    reportOrigin: () => reportOrigin(hostname, boundPort),
    terminal: options.terminal === true,
    detachMinutes: options.detachMinutes,
    launchCompanion: options.launchCompanion,
    noGit: options.noGit,
    profile: options.profile,
    app: options.app,
  });
  const registry = fetchHandler.terminal;
  const server = serve({
    port,
    hostname,
    idleTimeout: options.idleTimeout ?? STUDIO_IDLE_TIMEOUT_SECONDS,
    fetch: fetchHandler,
    websocket: {
      open(ws) {
        if (ws.data.service) {
          ws.data.service.open({
            send: (data) => void ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          });
          return;
        }
        if (!registry) return ws.close(1008, "the terminal is not enabled");
        ws.data.connection = registry.connect({
          send: (data) => void ws.send(data),
          bufferedAmount: () => ws.getBufferedAmount(),
          ping: () => ws.ping(),
          close: (code, reason) => ws.close(code, reason),
        });
      },
      message(ws, message) {
        if (ws.data.service) return ws.data.service.message(message);
        void ws.data.connection?.message(message);
      },
      close(ws) {
        if (ws.data.service) return ws.data.service.close();
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
  });
  boundPort = server.port;
  const loopback = hostname === STUDIO_HOSTNAME || hostname === "localhost" || hostname === "::1";
  const urlHostname = loopback ? "localhost" : urlHost(hostname);

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
