/**
 * Service plugin contract: what a plugin declares to run a service next to Mate — its own
 * top-level command, a background daemon Studio connects to, and Studio routes, views and
 * terminal sessions. A types-only leaf, so `@uniqbit/mate-core/plugin-api` typechecks in a
 * strict consumer project. The host checks `apiVersion` against the versions it supports.
 */

import type { StudioConnection } from "../../cli/commands/studio/connection";

/** Service API version this contract describes. Grows only on breaking changes. */
export type ServiceApiVersion = 1;

/** Where a service's background daemon listens. */
export type ServiceConnection = { kind: "socket"; path: string } | { kind: "url"; url: string };

/** A top-level command, `<distribution> <name> …`. Built-in commands always win. */
export interface ServiceCommand {
  name: string;
  /** One line per usage form for `mate help`, without the distribution name. */
  usage: string[];
  /** Receives every argument after the command name. Runs without companion or install gates. */
  run(argv: string[]): Promise<void>;
}

/** A plugin's service. Mounted from `Plugin.service`. */
export interface PluginService {
  apiVersion: ServiceApiVersion;
  /** Namespace of its routes (`/api/plugins/<id>/`) and views; lowercase kebab-case. */
  id: string;
  label: string;
  command?: ServiceCommand;
  /**
   * The daemon's connection, read from the environment Studio starts in. `null` means the
   * daemon is not there: Studio then leaves the service out. Absent: the service has no daemon.
   */
  connection?(env: NodeJS.ProcessEnv): ServiceConnection | null;
  /** Called once per Studio server after the connection resolved; `null` contributes nothing. */
  studio?(
    host: StudioServiceHost,
  ): StudioServiceContribution | null | Promise<StudioServiceContribution | null>;
}

/** What core lends a service inside Studio. */
export interface StudioServiceHost {
  apiVersion: ServiceApiVersion;
  /** The resolved daemon connection; `null` for a service without one. */
  connection: ServiceConnection | null;
  /** Studio was started with `--writable`. */
  writable: boolean;
  /** Studio terminal launches skip companion Git synchronization (`--no-git`). */
  noGit: boolean;
  /** The companion Studio was started for, when pinned. */
  launchCompanion: string | null;
  /** The Mate invocation prefix (e.g. `[bun, cli.mjs]`), for argv a service hands the terminal. */
  mateCommand: string[];
  env: NodeJS.ProcessEnv;
  /** Path of the registered companion with this digest; throws when none is registered. */
  companionPath(digest: string): Promise<string>;
  /**
   * The registered companion with this digest as Studio's own views read it; `refresh`
   * collects it again first. Throws when none is registered.
   */
  companionSnapshot(
    digest: string,
    options?: { refresh?: boolean },
  ): Promise<StudioCompanionSnapshot>;
  /** The digest Studio addresses a companion path by. */
  companionDigest(companionPath: string): string;
  /** The companion a terminal launch for `digest` targets (the pinned one first); `null` when none. */
  launchTarget(digest: string | null): Promise<string | null>;
  /** Tells open Studio pages that the companion's Workset board changed. */
  boardChanged(companionPath: string): void;
  /** The companion's hosted reports. */
  reports: {
    publish(
      companionPath: string,
      report: { title: string; html: string },
    ): Promise<{ id: string }>;
    ids(companionPath: string): Promise<string[]>;
  };
  /** Studio's terminal sessions; without `--terminal` there are none and `close` ends nothing. */
  terminal: StudioTerminalHost;
}

/** A companion as Studio collected it for its views. */
export interface StudioCompanionSnapshot {
  /**
   * The collected payload, `StudioCompanionPayload` of `@uniqbit/mate-core/studio` (typed
   * loosely so this module stays a leaf); `null` when collecting failed.
   */
  payload: object | null;
  /** Why collecting failed; `null` when it did not. */
  error: string | null;
  /** When it was collected, in ms since the epoch; `null` when it never was. */
  collectedAt: number | null;
}

/** Why a service ends a person's Workset session; the terminal tells the person. */
export type WorksetSessionCloseReason = "returned" | "deleted";

/** Studio's terminal as a service sees it. */
export interface StudioTerminalHost {
  /** Studio runs with `--terminal`. */
  enabled: boolean;
  /** Live sessions; `workset` is set for one a service's terminal session provider started. */
  sessions(): { id: string; companionPath: string; workset?: { id: string; title: string } }[];
  /** Worksets with at least one open session. */
  busy(): ReadonlySet<string>;
  /** Called once a Workset's session left the terminal and its process was reaped. */
  onEnded(listener: (worksetId: string) => void): () => void;
  /** Ends the companion's sessions for the Workset; resolves once they are reaped. */
  close(companionPath: string, worksetId: string, reason: WorksetSessionCloseReason): Promise<void>;
}

/** What a service adds to one Studio server. Every part is optional. */
export interface StudioServiceContribution {
  /** Served below `/api/plugins/<id>/`. */
  routes?: StudioRoute[];
  /** Listed in Studio's navigation. */
  views?: StudioView[];
  /** Starts terminal sessions for Worksets; the first service that offers it owns them. */
  worksetSessions?: StudioWorksetSessions;
  /** Adds companions Studio could not reach itself; the first service that offers it owns it. */
  companions?: StudioCompanionSource;
  /** Companions Studio refuses to delete while the service runs for them. */
  pinnedCompanions?: string[];
  /** Called when Studio stops. */
  close?(): Promise<void>;
}

/**
 * How a route is guarded, decided before it runs. `read`: Studio's token where reading needs
 * it. `write`: same origin and the save token; with `writable`, also `--writable`, refused
 * with that text otherwise. `socket`: a WebSocket, guarded like a write.
 */
export type StudioRouteAccess =
  | { kind: "read" }
  | { kind: "write"; writable?: string }
  | { kind: "socket" };

export type StudioRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface StudioRouteContext {
  /** The path below the service's prefix, starting with `/`. */
  path: string;
  url: URL;
  /** Lifts the idle timeout for a long-lived answer such as server-sent events. */
  keepOpen(): void;
}

/** One route. `HEAD` follows `GET`. */
export interface StudioRoute {
  /** Below the service prefix, starting with `/`; a trailing `/*` also matches every deeper path. */
  path: string;
  methods: Partial<Record<StudioRouteMethod, StudioRouteAccess>>;
  /** Answers an HTTP request; a `socket` method is answered by `socket` instead. */
  handle?(request: Request, context: StudioRouteContext): Promise<Response>;
  /** Accepts a WebSocket upgrade; `null` refuses it. */
  socket?(request: Request, context: StudioRouteContext): StudioSocketHandler | null;
}

/** The open end of a service's WebSocket. */
export interface StudioSocketPeer {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface StudioSocketHandler {
  open(peer: StudioSocketPeer): void;
  message(data: string | Uint8Array): void;
  close(): void;
}

/**
 * A view in Studio's navigation. With `module`, Studio serves `module.dir` below
 * `/studio/plugins/<id>/` and mounts `module.entry` (an ES module whose `mount` export is
 * {@link StudioViewMount}) at `/plugins/<id>/<view id>`.
 */
export interface StudioView {
  id: string;
  label: string;
  description?: string;
  module?: { dir: string; entry: string };
  /**
   * Path of a `read` GET route of the service (below its prefix) that answers
   * `{ count: number }` for `?companion=<digest>`: how many things in the view wait on the
   * person. Studio shows a count above zero on the view's navigation entry.
   */
  attention?: string;
  /**
   * `"workspace"`: the view fills Studio's main area edge to edge, without Studio's page header
   * (the view shows its own), and the agent terminal stays collapsed while the view is shown, until
   * the person expands it. Default `"page"`.
   */
  layout?: StudioViewLayout;
}

export type StudioViewLayout = "page" | "workspace";

/** What a view module's `mount` export receives in the browser. */
export interface StudioViewMountContext {
  /** Digest of the selected companion; `null` when none is selected. */
  companion: string | null;
  /** The service's route prefix, e.g. `/api/plugins/factory`. */
  apiBase: string;
  writable: boolean;
  /** Studio's connection state; absent in a Studio older than this field. */
  connection?: StudioConnection;
}

/** A view module's `mount` export; returns its unmount. */
export type StudioViewMount = (element: HTMLElement, context: StudioViewMountContext) => () => void;

/** A Workset terminal session start, resolved on the server; the browser named only the Workset. */
export type WorksetSessionResolution =
  | {
      companionPath: string;
      workset: { id: string; title: string };
      argv: string[];
      /** Shown before the session's output. */
      notice?: string;
    }
  | { reason: string };

export interface StudioWorksetSessions {
  resolve(
    worksetId: string,
    companionDigest: string | null,
    sessionId: string,
  ): Promise<WorksetSessionResolution>;
  /** The session's agent exited by itself; not called when the session was ended. */
  onExit?(worksetId: string, companionPath: string): Promise<void>;
}

/** A refusal is an answer; `tokenKey` names the Git token (`host/org`) that would unlock it. */
export type CompanionSourceResult =
  | { ok: true; path: string; existing: boolean }
  | { ok: false; reason: string; tokenKey?: string };

export interface StudioCompanionSource {
  /** Where the service keeps companions it fetched; Studio deletes folders only inside it. */
  folder: string;
  /** Fetches a companion by Git URL into `folder`; core registers it. */
  addByUrl(url: string): Promise<CompanionSourceResult>;
}
