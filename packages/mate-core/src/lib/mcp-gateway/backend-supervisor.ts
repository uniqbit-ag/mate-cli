import { BackendProcess } from "./backend-process";
import type { CompanionMcpServer } from "./companion-mcp-config";
import { serverConfigHash } from "./config-hash";
import type { GatewayConnection } from "./connection";
import type { GatewayLogger } from "./gateway-log";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import type { ManifestCache } from "./manifest-cache";
import { manifestsEqual } from "./manifest-cache";
import type { ToolSource } from "./mcp-surface";
import type { McpToolDescriptor } from "./tool-namespace";

export const DEFAULT_BACKEND_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;

interface ManagedBackend {
  key: string;
  configHash: string;
  server: CompanionMcpServer;
  /** Spawn promise is stored immediately so concurrent calls share one backend. */
  process: Promise<BackendProcess>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
  connectionId: number | null;
}

export interface BackendStatus {
  key: string;
  server: string;
  configHash: string;
  pid: number | undefined;
  idleMs: number;
  isolation: "shared" | "connection";
  connectionId: number | null;
}

export interface BackendSupervisorOptions {
  cache: ManifestCache;
  logger?: GatewayLogger;
  idleTtlMs?: number;
  requestTimeoutMs?: number;
  maxConsecutiveCrashes?: number;
  /** Fired when a real spawn reveals drift vs the cached manifest. */
  onManifestChanged?: (configHash: string) => void;
}

/**
 * Lazy backend lifecycle: `tools/list` is served from the manifest cache;
 * a backend spawns on first `tools/call` (or first-ever manifest fetch), is
 * reaped after an idle TTL (manifest survives), and respawns on the next use
 * after a crash — bounded by a consecutive-crash cap.
 */
export class BackendSupervisor implements ToolSource {
  private readonly cache: ManifestCache;
  private readonly logger: GatewayLogger;
  private readonly idleTtlMs: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly maxConsecutiveCrashes: number;
  private readonly onManifestChanged?: (configHash: string) => void;
  private readonly backends = new Map<string, ManagedBackend>();
  private readonly crashCounts = new Map<string, number>();
  private stopped = false;

  constructor(options: BackendSupervisorOptions) {
    this.cache = options.cache;
    this.logger = options.logger ?? NULL_GATEWAY_LOGGER;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_BACKEND_IDLE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxConsecutiveCrashes = options.maxConsecutiveCrashes ?? DEFAULT_MAX_CONSECUTIVE_CRASHES;
    this.onManifestChanged = options.onManifestChanged;
  }

  async listTools(
    server: CompanionMcpServer,
    _connection: GatewayConnection,
  ): Promise<McpToolDescriptor[]> {
    const configHash = serverConfigHash(server);
    const cached = await this.cache.get(configHash);
    if (cached) return cached.tools;
    /* First-ever use of this config: spawn once to learn the manifest. */
    const backend = await this.ensureBackend(server, null);
    const tools = await backend.listTools();
    await this.cache.set(configHash, tools, describeCommand(server));
    return tools;
  }

  async callTool(
    server: CompanionMcpServer,
    toolName: string,
    args: unknown,
    connection: GatewayConnection,
  ): Promise<unknown> {
    const connectionId = server.isolation === "connection" ? connection.id : null;
    let backend = await this.ensureBackend(server, connectionId);
    try {
      return await backend.callTool(toolName, args);
    } catch (error) {
      if (backend.isAlive) throw error;
      /* Crash mid-call: one respawn-and-retry before surfacing the failure. */
      backend = await this.ensureBackend(server, connectionId);
      return backend.callTool(toolName, args);
    }
  }

  /** Per-connection backends die with their connection. */
  releaseConnection(connectionId: number): void {
    for (const managed of this.backends.values()) {
      if (managed.connectionId === connectionId) {
        void this.reap(managed, "connection_closed");
      }
    }
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    for (const managed of this.backends.values()) {
      await this.reap(managed, "shutdown");
    }
  }

  async status(): Promise<BackendStatus[]> {
    const statuses: BackendStatus[] = [];
    for (const managed of this.backends.values()) {
      const process = await managed.process.catch(() => null);
      if (!process?.isAlive) continue;
      statuses.push({
        key: managed.key,
        server: managed.server.name,
        configHash: managed.configHash,
        pid: process.pid,
        idleMs: Date.now() - managed.lastUsedAt,
        isolation: managed.server.isolation,
        connectionId: managed.connectionId,
      });
    }
    return statuses;
  }

  private backendKey(configHash: string, connectionId: number | null): string {
    return connectionId === null ? configHash : `${configHash}#connection-${connectionId}`;
  }

  private async ensureBackend(
    server: CompanionMcpServer,
    connectionId: number | null,
  ): Promise<BackendProcess> {
    if (this.stopped) throw new Error("gateway is shutting down");
    const configHash = serverConfigHash(server);
    const key = this.backendKey(configHash, connectionId);

    const existing = this.backends.get(key);
    if (existing) {
      const process = await existing.process.catch(() => null);
      if (process?.isAlive) {
        this.touch(existing);
        return process;
      }
      this.backends.delete(key);
    }

    const crashes = this.crashCounts.get(key) ?? 0;
    if (crashes >= this.maxConsecutiveCrashes) {
      throw new Error(
        `backend ${server.name} crashed ${crashes} times in a row; not respawning (fix the server config and retry)`,
      );
    }

    const managed: ManagedBackend = {
      key,
      configHash,
      server,
      process: this.spawn(server, key, configHash),
      idleTimer: null,
      lastUsedAt: Date.now(),
      connectionId,
    };
    this.backends.set(key, managed);
    try {
      const process = await managed.process;
      /* Reap removes the entry before killing; entry still present == crash. */
      process.onExit(() => {
        if (managed.idleTimer) clearTimeout(managed.idleTimer);
        if (this.backends.get(key) === managed) {
          this.backends.delete(key);
          this.crashCounts.set(key, (this.crashCounts.get(key) ?? 0) + 1);
          this.logger.log("warn", "backend.crashed", { server: server.name, configHash });
        }
      });
      this.touch(managed);
      return process;
    } catch (error) {
      this.backends.delete(key);
      this.crashCounts.set(key, (this.crashCounts.get(key) ?? 0) + 1);
      throw error;
    }
  }

  private async spawn(
    server: CompanionMcpServer,
    key: string,
    configHash: string,
  ): Promise<BackendProcess> {
    const backend = await BackendProcess.start(server, {
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.logger.log("info", "backend.spawned", {
      server: server.name,
      configHash,
      pid: backend.pid,
    });

    /* Schema-drift check: a real spawn is the only time truth is observable. */
    try {
      const tools = await backend.listTools();
      const cached = await this.cache.get(configHash);
      if (!cached || !manifestsEqual(cached.tools, tools)) {
        await this.cache.set(configHash, tools, describeCommand(server));
        if (cached) {
          this.logger.log("info", "backend.manifest_drift", { server: server.name, configHash });
          this.onManifestChanged?.(configHash);
        }
      }
      /* A working tools/list proves the config; only then does the crash streak reset. */
      this.crashCounts.delete(key);
    } catch {
      /* drift check is advisory; the call that triggered the spawn proceeds */
    }

    return backend;
  }

  private touch(managed: ManagedBackend): void {
    managed.lastUsedAt = Date.now();
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (this.idleTtlMs === Infinity) return;
    managed.idleTimer = setTimeout(() => {
      void this.reap(managed, "idle_ttl");
    }, this.idleTtlMs);
  }

  private async reap(managed: ManagedBackend, reason: string): Promise<void> {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    this.backends.delete(managed.key);
    const process = await managed.process.catch(() => null);
    if (process?.isAlive) {
      process.kill();
      this.logger.log("info", "backend.reaped", {
        server: managed.server.name,
        configHash: managed.configHash,
        reason,
      });
    }
  }
}

function describeCommand(server: CompanionMcpServer): string {
  return [server.command, ...server.args].join(" ");
}
