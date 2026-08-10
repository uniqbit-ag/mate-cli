import type { GlobalConfigStore } from "../orchestrator/global-config-store";
import { BackendSupervisor } from "./backend-supervisor";
import { GatewayChangeWatcher } from "./change-watcher";
import { serverConfigHash } from "./config-hash";
import { GatewayConnection, type ConnectionResolver } from "./connection";
import { GatewayDaemon, type GatewayDaemonOptions } from "./daemon";
import { createGatewayLogger, type GatewayLogger } from "./gateway-log";
import { gatewayPaths, type GatewayPaths } from "./gateway-paths";
import { GatewayConnectionResolver } from "./gateway-resolver";
import { ManifestCache } from "./manifest-cache";
import { GatewayMcpSurface, type ToolSource } from "./mcp-surface";

export interface GatewayRuntimeOptions {
  version: string;
  paths?: GatewayPaths;
  idleShutdownMs?: Exclude<GatewayDaemonOptions["idleShutdownMs"], undefined>;
  logger?: GatewayLogger;
  resolver: ConnectionResolver;
  toolSource: ToolSource;
  /** Runs before each tools/list as the defensive re-resolve fallback. */
  beforeToolsList?: (connection: GatewayConnection) => Promise<void>;
  /** Observers for the change-propagation layer. */
  onConnectionReady?: (connection: GatewayConnection) => void;
  onConnectionClosed?: (connection: GatewayConnection) => void;
}

export interface GatewayStatusConnection {
  id: number;
  cwd: string | null;
  repoRoot: string | null;
  companionPath: string | null;
  clientVersion: string | null;
  servers: string[];
}

export interface GatewayStatus {
  version: string;
  pid: number;
  connections: GatewayStatusConnection[];
  backends?: unknown;
  manifestCache?: unknown;
}

export interface GatewayStatusBackend {
  server: string;
  configHash: string;
  pid: number | undefined;
  idleMs: number;
  isolation: "shared" | "connection";
  connectionId: number | null;
}

export interface GatewayStatusManifest {
  configHash: string;
  command: string;
  toolCount: number;
  updatedAt: string;
}

/**
 * Composition root: daemon socket lifecycle + per-connection handshake/MCP
 * surface. Backend lifecycle and change watching attach through the options.
 */
export class GatewayRuntime {
  readonly daemon: GatewayDaemon;
  readonly surface: GatewayMcpSurface;
  readonly connections = new Set<GatewayConnection>();
  private readonly options: GatewayRuntimeOptions;
  /** Extended by the backend layer for `mate mcp status`. */
  statusExtras: () => Promise<Partial<GatewayStatus>> = async () => ({});

  constructor(options: GatewayRuntimeOptions) {
    this.options = options;
    const paths = options.paths ?? gatewayPaths();
    const logger = options.logger ?? createGatewayLogger(paths.logPath);
    this.surface = new GatewayMcpSurface({
      version: options.version,
      toolSource: options.toolSource,
      logger,
      beforeToolsList: options.beforeToolsList,
    });
    this.daemon = new GatewayDaemon({
      version: options.version,
      paths,
      idleShutdownMs: options.idleShutdownMs,
      logger,
      connectionHandler: (socket, daemon) => {
        const connection = new GatewayConnection(socket, {
          daemon,
          resolver: options.resolver,
          surface: this.surface,
          onDrainRequested: () => void daemon.drain(),
          buildStatus: () => this.buildStatus(),
          onHello: (ready) => {
            this.connections.add(ready);
            options.onConnectionReady?.(ready);
          },
          onClose: (closed) => {
            this.connections.delete(closed);
            this.surface.releaseConnection(closed);
            options.onConnectionClosed?.(closed);
          },
        });
        void connection;
      },
    });
  }

  async buildStatus(): Promise<GatewayStatus> {
    return {
      version: this.options.version,
      pid: process.pid,
      connections: [...this.connections].map((connection) => ({
        id: connection.id,
        cwd: connection.cwd,
        repoRoot: connection.resolution.repoRoot,
        companionPath: connection.resolution.companionPath,
        clientVersion: connection.clientVersion,
        servers: connection.resolution.servers.map((server) => server.name),
      })),
      ...(await this.statusExtras()),
    };
  }

  async start(): Promise<void> {
    await this.daemon.start();
  }

  async stop(): Promise<void> {
    await this.daemon.stop();
  }
}

export interface CreateGatewayOptions {
  version: string;
  paths?: GatewayPaths;
  idleShutdownMs?: number;
  backendIdleTtlMs?: number;
  watchDebounceMs?: number;
  logger?: GatewayLogger;
  /** Test override for the trust registry. */
  globalConfigStore?: GlobalConfigStore;
}

export interface Gateway {
  runtime: GatewayRuntime;
  supervisor: BackendSupervisor;
  watcher: GatewayChangeWatcher;
  cache: ManifestCache;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Full daemon assembly: trust-gated resolver, manifest-cached lazy backends,
 * pin/config watchers with per-connection `list_changed`, status introspection.
 */
export function createGateway(options: CreateGatewayOptions): Gateway {
  const paths = options.paths ?? gatewayPaths();
  const logger = options.logger ?? createGatewayLogger(paths.logPath);
  const resolver = new GatewayConnectionResolver({
    globalConfigStore: options.globalConfigStore,
    logger,
  });
  const cache = new ManifestCache(paths.manifestCachePath);

  let runtime: GatewayRuntime;
  const supervisor = new BackendSupervisor({
    cache,
    logger,
    idleTtlMs: options.backendIdleTtlMs,
    onManifestChanged: (configHash) => {
      /* Drift: refresh exactly the connections whose tool set includes this backend. */
      for (const connection of runtime.connections) {
        const affected = connection.resolution.servers.some(
          (server) => serverConfigHash(server) === configHash,
        );
        if (affected) {
          runtime.surface.releaseConnection(connection);
          connection.sendToolsListChanged();
        }
      }
    },
  });
  const watcher = new GatewayChangeWatcher({
    resolver,
    logger,
    debounceMs: options.watchDebounceMs,
    onResolutionChanged: (connection) => runtime.surface.releaseConnection(connection),
  });

  runtime = new GatewayRuntime({
    version: options.version,
    paths,
    idleShutdownMs: options.idleShutdownMs,
    logger,
    resolver,
    toolSource: supervisor,
    beforeToolsList: async (connection) => {
      await watcher.reResolveNow(connection);
    },
    onConnectionReady: (connection) => watcher.register(connection),
    onConnectionClosed: (connection) => {
      watcher.unregister(connection);
      supervisor.releaseConnection(connection.id);
    },
  });
  runtime.statusExtras = async () => ({
    backends: (await supervisor.status()).map((backend): GatewayStatusBackend => ({
      server: backend.server,
      configHash: backend.configHash,
      pid: backend.pid,
      idleMs: backend.idleMs,
      isolation: backend.isolation,
      connectionId: backend.connectionId,
    })),
    manifestCache: (await cache.list()).map((entry): GatewayStatusManifest => ({
      configHash: entry.configHash,
      command: entry.command,
      toolCount: entry.tools.length,
      updatedAt: entry.updatedAt,
    })),
  });

  const cleanup = async () => {
    watcher.stop();
    await supervisor.stopAll();
  };
  void runtime.daemon.whenStopped.then(cleanup);

  return {
    runtime,
    supervisor,
    watcher,
    cache,
    start: () => runtime.start(),
    stop: async () => {
      await runtime.stop();
    },
  };
}
