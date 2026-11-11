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
import { CompanionRemovalError, deleteRegisteredCompanion } from "./companion-removal";
import { collectStudioInventory, type StudioInventory } from "./inventory";
import {
  assembleCompanionPayload,
  readCompanionWorksetStages,
  type StudioCompanionResponse,
} from "./payload";
import { createReportStore, isReportId, REPORT_LIMITS, type ReportStore } from "./reports";
import { isWorksetId, WorksetError } from "../../../lib/workset/record";
import type { WorksetWithStage } from "../../../lib/workset/stages";
import type { LiveViewer } from "../../../lib/factory/runner/live";
import {
  createFactoryOutcomes,
  type FactoryOutcomes,
  type Outcomes,
  type OutcomesPorts,
  recordOutcomes,
} from "../../../lib/factory/outcomes";
import { LiveSessions } from "../../../lib/factory/outcomes/sessions";
import { FACTORY_BROKER_ENV, factoryClient, type FactoryClient } from "../../../lib/factory/client";
import { factoryCredentialResponse } from "./factory-credential";
import { createWorksetResolver } from "./workset-session";
import {
  FACTORY_CREDENTIAL_ROUTE,
  FACTORY_WORKSETS_ROUTE,
  REPORTS_ROUTE,
  REPORT_VIEW_PREFIX,
  STUDIO_EVENTS_ROUTE,
  STUDIO_HOSTNAME,
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
import type { StudioFormField, StudioServices } from "./services";
import type { UsageCache } from "../../../lib/usage/cache";
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
  data: { connection?: TerminalConnection };
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
  terminal?: Partial<TerminalRegistryOptions>;
  launchableAgents?: typeof launchableAgents;
  /**
   * The factory's Outcomes, built from the ports Studio creates first for the companion it
   * serves; from the environment in factory mode when absent.
   */
  factoryOutcomes?: (portsFor: (companionPath: string) => OutcomesPorts) => FactoryOutcomes | null;
  /** A companion's Workset stages; read from OpenSpec when absent. */
  worksetStages?: (companionPath: string) => Promise<{ worksets: WorksetWithStage[] }>;
  /** The factory broker's client; from the environment when absent, null outside factory mode. */
  factoryClient?: FactoryClient | null;
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

/** A Workset's run log, or its live stream when the second group matched. */
const FACTORY_LOG = new RegExp(`^${FACTORY_WORKSETS_ROUTE}/([^/]+)/log(/stream)?$`);

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

/** Every route core answers, by kind; the rest are reads the application answers. */
function routeOf(url: URL, method: string, hasApp: boolean): RouteKind {
  const { pathname } = url;
  if (pathname === REPORTS_ROUTE && method === "POST")
    return { kind: "session", methods: ["POST"] };
  if (pathname === FACTORY_CREDENTIAL_ROUTE) {
    return method === "GET" || method === "HEAD"
      ? { kind: "read", methods: [method] }
      : {
          kind: "write",
          methods: [method],
          writable: "start Studio with --writable to set the agent credential",
        };
  }
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
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) over = true;
    if (over) {
      chunks.length = 0;
      if (size > limit * 4) {
        await reader.cancel();
        break;
      }
    } else {
      chunks.push(value);
    }
  }
  return over ? null : Buffer.concat(chunks).toString("utf8");
}

const NOT_WRITABLE = "start Studio with --writable to create or start Worksets";

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
  const broker = deps.factoryClient !== undefined ? deps.factoryClient : factoryClient();
  const reports = deps.reports ?? createReportStore();
  const stagesOf = deps.worksetStages ?? ((path: string) => readCompanionWorksetStages(path));
  // Created before the terminal and the Outcomes, so neither needs the other.
  const sessions = new LiveSessions();
  const launchCompanion = options.launchCompanion ?? null;
  const outcomesPorts = (companionPath: string): OutcomesPorts => ({
    stages: () => stagesOf(companionPath),
    reports: {
      publish: (report) => reports.publish(companionDigest(companionPath), report),
      ids: async () =>
        (await reports.list(companionDigest(companionPath))).map((report) => report.id),
    },
    sessions,
  });
  const outcomes = (() => {
    try {
      if (deps.factoryOutcomes) return deps.factoryOutcomes(outcomesPorts);
      return createFactoryOutcomes(launchCompanion, outcomesPorts(launchCompanion ?? ""));
    } catch (error) {
      process.stderr.write(
        `mate studio: the factory runner did not start: ${(error as Error).message}\n`,
      );
      return null;
    }
  })();
  /** A companion's Outcomes: the factory's for the companion it runs, record-only otherwise. */
  const outcomesFor = (companionPath: string): Outcomes =>
    outcomes?.companionPath === companionPath
      ? outcomes
      : recordOutcomes(companionPath, () => stagesOf(companionPath));
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
  const terminal = options.terminal
    ? new TerminalRegistry({
        detachMs: (options.detachMinutes ?? DEFAULT_DETACH_MINUTES[access.invocation]) * 60_000,
        resolveLaunch: createLaunchResolver({
          collectInventory: inventory,
          launchCompanion,
          launchableAgents: (companionPath) => agentsFor(companionPath),
        }),
        mateCommand: process.argv.slice(0, 2),
        sessions,
        ...(process.env[FACTORY_BROKER_ENV]
          ? {
              resolveWorkset: createWorksetResolver({
                collectInventory: inventory,
                launchCompanion,
                mateCommand: process.argv.slice(0, 2),
                env: process.env,
                noGit: options.noGit === true,
                // A person in control continues the factory's own conversation.
                takenOver: async (id) => (outcomes ? outcomes.takenOver(id) : null),
              }),
            }
          : {}),
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
    const path = `${REPORT_VIEW_PREFIX}${stored.id}`;
    return json({
      id: stored.id,
      path,
      ...(publicOrigin ? { url: `${publicOrigin}${path}` } : {}),
    });
  };

  /** One document's model, with the factory and terminal state its address needs. */
  const collectPage = async (url: URL): Promise<StudioPage> => {
    const page = await collectStudioPage(url, policy, inventory, snapshots, writable);
    page.renderedAt = Date.now();
    page.factoryRuns = page.companion ? await outcomesFor(page.companion.path).runs() : null;
    if (terminal) {
      const target = await effectiveLaunchCompanion(
        page.inventory,
        launchCompanion,
        page.selection.companionDigest,
      );
      page.worksetSessions = process.env[FACTORY_BROKER_ENV]
        ? Object.fromEntries(
            terminal
              .list()
              .flatMap((session) => (session.workset ? [[session.workset.id, session.id]] : [])),
          )
        : null;
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
  if (outcomes) {
    const digest = companionDigest(outcomes.companionPath);
    outcomes.onChanged(() => boardChanged(digest));
  }

  let usage: Promise<UsageCache> | undefined = deps.usage && Promise.resolve(deps.usage);
  const services: StudioServices = {
    writable,
    factoryMode: broker !== null,
    modePolicy: policy,
    page: collectPage,
    worksetAction: async (digest, id, action, field: StudioFormField) => {
      if (!writable) throw new WorksetError(NOT_WRITABLE);
      await outcomesFor(await companionPathOf(digest)).act(id, action, field);
      boardChanged(digest);
    },
    createOutcome: async (digest, field) => {
      if (!writable) throw new WorksetError(NOT_WRITABLE);
      await outcomesFor(await companionPathOf(digest)).create(field);
      boardChanged(digest);
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
    vaultPreview: async (digest, path, content) => {
      await companionPathOf(digest);
      const { markdownTree } = await import("./views/vault/markdown-tree");
      return markdownTree(content, path);
    },
    vaultSave: async (digest, path, content, token) => {
      if (!writable) throw new VaultPathError("start Studio with --writable to enable saving");
      return vault.save(await companionPathOf(digest), path, content, token);
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
    skillPreview: async (digest, agent, name, file) => {
      const { readSkillPreview } = await import("./skill-files");
      return readSkillPreview(await companionPathOf(digest), agent, name, file);
    },
    deleteCompanion: async (digest) => {
      if (!writable) {
        throw new CompanionRemovalError("start Studio with --writable to delete companions");
      }
      const companionPath = await companionPathOf(digest);
      const pinned = [launchCompanion, outcomes?.companionPath].filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      );
      // Real paths, so a symlinked start path still protects its folder.
      const real = (entry: string) => realpath(entry).catch(() => path.resolve(entry));
      const target = await real(companionPath);
      const pinnedReal = await Promise.all(pinned.map(real));
      if (pinnedReal.includes(target)) {
        throw new CompanionRemovalError(
          "Studio was started for this companion; it is not deleted.",
        );
      }
      const { deletedFolder } = await deleteRegisteredCompanion(companionPath);
      return { deletedFolder };
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

    const route = routeOf(url, request.method, app !== null);
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

    if (url.pathname === FACTORY_CREDENTIAL_ROUTE) {
      if (broker === null) return respond(notFound());
      return respond(await factoryCredentialResponse(broker, request));
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

    const logMatch = FACTORY_LOG.exec(url.pathname);
    if (logMatch) {
      const id = decodeURIComponent(logMatch[1]!);
      if (!outcomes || !isWorksetId(id)) return respond(notFound());
      if (logMatch[2]) return respond(logStream(outcomes, id));
      return respond(
        new Response(await outcomes.log(id), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        }),
      );
    }

    // Everything else is the application's: its documents, views and server functions.
    if (app) return respond(await app.fetch(request, { context: { studio: services } }));
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
  handler.services = services;
  handler.close = async () => {
    vault.stop();
    await terminal?.stopAll();
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

/** Server-sent events: `subscribe` gets a send function and returns its unsubscribe. */
function eventStream(
  greeting: string,
  subscribe: (send: (event: unknown) => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`: ${greeting}\n\n`));
      unsubscribe = subscribe((event) => {
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
 * A Workset's run log as it grows: one `replay` (the stored log and the text still
 * streaming), then the live events. Read-only; leaving never touches the run.
 */
function logStream(live: { watch(id: string): LiveViewer }, id: string): Response {
  return eventStream("studio factory log", (send) => {
    const viewer = live.watch(id);
    void (async () => {
      send({ type: "replay", ...(await viewer.replay) });
      // oxlint-disable-next-line no-await-in-loop -- events arrive one at a time, in order
      for (let event = await viewer.next(); event; event = await viewer.next()) send(event);
    })().catch(() => viewer.close());
    return () => viewer.close();
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
