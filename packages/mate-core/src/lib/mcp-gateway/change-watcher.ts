import fs from "node:fs";
import path from "node:path";

import { serverConfigHash } from "./config-hash";
import type { ConnectionResolution, ConnectionResolver, GatewayConnection } from "./connection";
import type { GatewayLogger } from "./gateway-log";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";

const DEFAULT_DEBOUNCE_MS = 150;

/** Files whose change can flip a connection's tool set. */
const RELEVANT_FILENAMES = new Set([
  "registry.yaml",
  "mcp.yaml",
  "opencode.json",
  ".mcp.json",
  ".mate",
  ".opencode",
  "config",
]);

export function resolutionsEqual(a: ConnectionResolution, b: ConnectionResolution): boolean {
  if (a.companionPath !== b.companionPath) return false;
  const key = (resolution: ConnectionResolution) =>
    resolution.servers
      .map((server) => `${server.name}:${serverConfigHash(server)}:${server.isolation}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

interface WatchedConnection {
  connection: GatewayConnection;
  watchers: fs.FSWatcher[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  reResolving: boolean;
}

export interface GatewayChangeWatcherOptions {
  resolver: ConnectionResolver;
  logger?: GatewayLogger;
  debounceMs?: number;
  /** Invalidate per-connection surface state when the tool set swaps. */
  onResolutionChanged?: (connection: GatewayConnection) => void;
}

/**
 * Watches each connected repo's pin file and the active companion's MCP config
 * files; a relevant change re-resolves that connection and emits
 * `list_changed` on it alone. The surface's defensive re-resolve on
 * `tools/list` (`reResolveNow`) backstops missed fs events.
 */
export class GatewayChangeWatcher {
  private readonly options: GatewayChangeWatcherOptions;
  private readonly logger: GatewayLogger;
  private readonly debounceMs: number;
  private readonly watched = new Map<number, WatchedConnection>();

  constructor(options: GatewayChangeWatcherOptions) {
    this.options = options;
    this.logger = options.logger ?? NULL_GATEWAY_LOGGER;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  register(connection: GatewayConnection): void {
    this.unregister(connection);
    const entry: WatchedConnection = {
      connection,
      watchers: [],
      debounceTimer: null,
      reResolving: false,
    };
    this.watched.set(connection.id, entry);
    this.attachWatchers(entry);
  }

  unregister(connection: GatewayConnection): void {
    const entry = this.watched.get(connection.id);
    if (!entry) return;
    this.watched.delete(connection.id);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    for (const watcher of entry.watchers) watcher.close();
  }

  stop(): void {
    for (const entry of this.watched.values()) {
      this.unregister(entry.connection);
    }
  }

  /** Defensive re-resolve used both by watch events and before tools/list. */
  async reResolveNow(connection: GatewayConnection): Promise<boolean> {
    const entry = this.watched.get(connection.id);
    if (entry?.reResolving) return false;
    if (entry) entry.reResolving = true;
    try {
      const cwd = connection.cwd;
      if (!cwd) return false;
      let next: ConnectionResolution;
      try {
        next = await this.options.resolver.resolveConnection(cwd);
      } catch (error) {
        this.logger.log("warn", "watcher.re_resolve_failed", {
          connection: connection.id,
          error: (error as Error).message,
        });
        return false;
      }
      if (resolutionsEqual(connection.resolution, next)) return false;
      const previous = connection.resolution;
      connection.resolution = next;
      this.options.onResolutionChanged?.(connection);
      this.logger.log("info", "watcher.tool_set_swapped", {
        connection: connection.id,
        fromCompanion: previous.companionPath,
        toCompanion: next.companionPath,
      });
      if (entry) this.attachWatchers(entry);
      return true;
    } finally {
      if (entry) entry.reResolving = false;
    }
  }

  private attachWatchers(entry: WatchedConnection): void {
    for (const watcher of entry.watchers.splice(0)) watcher.close();
    for (const dir of this.watchRoots(entry.connection)) {
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename && !RELEVANT_FILENAMES.has(path.basename(filename))) return;
          this.scheduleReResolve(entry);
        });
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
      } catch {
        /* directory vanished between resolve and watch — the tools/list fallback covers it */
      }
    }
  }

  /** Existing directories that contain the pin or companion MCP config files. */
  private watchRoots(connection: GatewayConnection): string[] {
    const roots = new Set<string>();
    const { repoRoot, companionPath } = connection.resolution;
    if (repoRoot) {
      roots.add(path.join(repoRoot, ".mate", "config"));
      roots.add(path.join(repoRoot, ".mate"));
    }
    if (companionPath) {
      roots.add(companionPath);
      roots.add(path.join(companionPath, ".mate"));
      roots.add(path.join(companionPath, ".opencode"));
    }
    return [...roots].filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private scheduleReResolve(entry: WatchedConnection): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.reResolveNow(entry.connection).then((changed) => {
        if (changed) entry.connection.sendToolsListChanged();
      });
    }, this.debounceMs);
  }
}
