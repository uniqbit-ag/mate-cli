import fs from "node:fs/promises";
import net from "node:net";

import { createGatewayLogger, type GatewayLogger } from "./gateway-log";
import { gatewayPaths, type GatewayPaths } from "./gateway-paths";

export interface GatewayDaemonState {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: string;
}

export interface GatewayDaemonOptions {
  version: string;
  paths?: GatewayPaths;
  /** Self-shutdown after this long with zero connections. */
  idleShutdownMs?: number;
  logger?: GatewayLogger;
  /** Wired by the connection layer; the skeleton only tracks socket lifetime. */
  connectionHandler?: (socket: net.Socket, daemon: GatewayDaemon) => void;
}

export const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;

export class GatewayDaemonAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`mate MCP gateway daemon already listening on ${socketPath}`);
  }
}

export class GatewayDaemon {
  readonly paths: GatewayPaths;
  readonly version: string;
  readonly logger: GatewayLogger;
  private readonly idleShutdownMs: number;
  private readonly connectionHandler?: (socket: net.Socket, daemon: GatewayDaemon) => void;

  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private draining = false;
  private stoppedResolve: (() => void) | null = null;
  /** Resolves when the daemon has fully stopped (idle shutdown, drain, or stop()). */
  readonly whenStopped: Promise<void>;

  constructor(options: GatewayDaemonOptions) {
    this.version = options.version;
    this.paths = options.paths ?? gatewayPaths();
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.logger = options.logger ?? createGatewayLogger(this.paths.logPath);
    this.connectionHandler = options.connectionHandler;
    this.whenStopped = new Promise((resolve) => {
      this.stoppedResolve = resolve;
    });
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.paths.runDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.paths.runDir, 0o700);
    await this.clearStaleSocket();

    const server = net.createServer((socket) => this.acceptConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          reject(new GatewayDaemonAlreadyRunningError(this.paths.socketPath));
        } else {
          reject(error);
        }
      };
      server.once("error", onError);
      server.listen(this.paths.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const state: GatewayDaemonState = {
      pid: process.pid,
      version: this.version,
      socketPath: this.paths.socketPath,
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    this.armIdleTimer();
    this.logger.log("info", "daemon.started", { version: this.version, pid: process.pid });
  }

  /**
   * Drain for version takeover: unlink socket + state so a successor can bind,
   * stop accepting, keep serving live connections, exit when the last closes.
   */
  async drain(): Promise<void> {
    if (this.draining || this.stopping) return;
    this.draining = true;
    this.logger.log("info", "daemon.draining", { connections: this.sockets.size });
    /* Unlink FIRST (D3): once the path is free a successor may bind and write
       its own socket/state — no fs op of ours may run after that point. */
    await this.unlinkArtifacts();
    await this.closeServer();
    if (this.sockets.size === 0) await this.finishStop();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    /* Destroy before closing: server.close() only completes once every connection is gone. */
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await this.unlinkArtifacts();
    await this.closeServer();
    await this.finishStop();
  }

  private acceptConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    this.clearIdleTimer();
    this.logger.log("debug", "connection.opened", { connections: this.sockets.size });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.logger.log("debug", "connection.closed", { connections: this.sockets.size });
      if (this.sockets.size === 0) {
        if (this.draining) {
          void this.finishStop();
        } else if (!this.stopping) {
          this.armIdleTimer();
        }
      }
    });
    socket.on("error", () => socket.destroy());
    this.connectionHandler?.(socket, this);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleShutdownMs === Infinity) return;
    this.idleTimer = setTimeout(() => {
      if (this.sockets.size > 0 || this.stopping) return;
      this.logger.log("info", "daemon.idle_shutdown", { idleMs: this.idleShutdownMs });
      void this.stop();
    }, this.idleShutdownMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async unlinkArtifacts(): Promise<void> {
    this.clearIdleTimer();
    await fs.rm(this.paths.socketPath, { force: true }).catch(() => {});
    await this.removeOwnStateFile();
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async finishStop(): Promise<void> {
    this.stopping = true;
    this.logger.log("info", "daemon.stopped", {});
    this.stoppedResolve?.();
  }

  /** Only remove gateway.json when it still points at this process. */
  private async removeOwnStateFile(): Promise<void> {
    try {
      const raw = await fs.readFile(this.paths.statePath, "utf8");
      const state = JSON.parse(raw) as GatewayDaemonState;
      if (state.pid === process.pid) await fs.rm(this.paths.statePath, { force: true });
    } catch {
      /* absent or foreign — leave it */
    }
  }

  /** A socket file nobody is listening on (crashed daemon) must not block startup. */
  private async clearStaleSocket(): Promise<void> {
    try {
      await fs.access(this.paths.socketPath);
    } catch {
      return;
    }
    const alive = await socketIsAlive(this.paths.socketPath);
    if (alive) throw new GatewayDaemonAlreadyRunningError(this.paths.socketPath);
    this.logger.log("warn", "daemon.stale_socket_removed", { socketPath: this.paths.socketPath });
    await fs.rm(this.paths.socketPath, { force: true });
  }
}

export async function socketIsAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function readGatewayState(statePath: string): Promise<GatewayDaemonState | null> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw) as GatewayDaemonState;
    if (typeof state.pid !== "number" || typeof state.version !== "string") return null;
    return state;
  } catch {
    return null;
  }
}
