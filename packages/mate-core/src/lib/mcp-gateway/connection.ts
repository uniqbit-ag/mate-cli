import type net from "node:net";

import type { CompanionMcpServer } from "./companion-mcp-config";
import type { GatewayDaemon } from "./daemon";
import {
  createLineReader,
  encodeControl,
  encodeRpc,
  parseFrame,
  type GatewayControl,
  type JsonRpcMessage,
} from "./frames";

/** What a session working directory resolves to. `companionPath` is null for unlinked/inactive repos. */
export interface ConnectionResolution {
  repoRoot: string | null;
  companionPath: string | null;
  servers: CompanionMcpServer[];
}

export interface ConnectionResolver {
  resolveConnection(cwd: string): Promise<ConnectionResolution>;
}

export interface McpSurface {
  handleRequest(connection: GatewayConnection, message: JsonRpcMessage): Promise<void>;
}

export interface GatewayConnectionDeps {
  daemon: GatewayDaemon;
  resolver: ConnectionResolver;
  surface: McpSurface;
  onDrainRequested?: () => void;
  buildStatus?: () => unknown | Promise<unknown>;
  onHello?: (connection: GatewayConnection) => void;
  onClose?: (connection: GatewayConnection) => void;
}

let nextConnectionId = 1;

export class GatewayConnection {
  readonly id: number;
  readonly socket: net.Socket;
  private readonly deps: GatewayConnectionDeps;

  /** Populated by the hello handshake. */
  clientVersion: string | null = null;
  cwd: string | null = null;
  /** Populated by resolution (and re-resolution on pin/config changes). */
  resolution: ConnectionResolution = { repoRoot: null, companionPath: null, servers: [] };

  private helloSeen = false;
  private closed = false;

  constructor(socket: net.Socket, deps: GatewayConnectionDeps) {
    this.id = nextConnectionId++;
    this.socket = socket;
    this.deps = deps;
    const readLines = createLineReader((line) => void this.handleLine(line));
    socket.on("data", readLines);
    socket.on("close", () => {
      this.closed = true;
      deps.onClose?.(this);
    });
  }

  get isReady(): boolean {
    return this.helloSeen;
  }

  sendControl(control: GatewayControl): void {
    if (!this.closed) this.socket.write(encodeControl(control));
  }

  sendRpc(message: JsonRpcMessage): void {
    if (!this.closed) this.socket.write(encodeRpc(message));
  }

  sendToolsListChanged(): void {
    this.sendRpc({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  private async handleLine(line: string): Promise<void> {
    const frame = parseFrame(line);
    if (frame.kind === "invalid") {
      this.deps.daemon.logger.log("warn", "connection.invalid_frame", {
        connection: this.id,
        reason: frame.reason,
      });
      return;
    }
    if (frame.kind === "control") {
      await this.handleControl(frame.control);
      return;
    }
    if (!this.helloSeen) {
      this.deps.daemon.logger.log("warn", "connection.rpc_before_hello", { connection: this.id });
      if (frame.message.id !== undefined) {
        this.sendRpc({
          jsonrpc: "2.0",
          id: frame.message.id,
          error: { code: -32002, message: "mate gateway: hello handshake required first" },
        });
      }
      return;
    }
    await this.deps.surface.handleRequest(this, frame.message);
  }

  private async handleControl(control: GatewayControl): Promise<void> {
    switch (control.type) {
      case "hello": {
        this.clientVersion = control.version;
        this.cwd = control.cwd;
        try {
          this.resolution = await this.deps.resolver.resolveConnection(control.cwd);
        } catch (error) {
          this.deps.daemon.logger.log("error", "connection.resolution_failed", {
            connection: this.id,
            cwd: control.cwd,
            error: (error as Error).message,
          });
          this.resolution = { repoRoot: null, companionPath: null, servers: [] };
        }
        this.helloSeen = true;
        this.deps.daemon.logger.log("info", "connection.hello", {
          connection: this.id,
          cwd: control.cwd,
          clientVersion: control.version,
          repoRoot: this.resolution.repoRoot,
          companionPath: this.resolution.companionPath,
        });
        this.sendControl({
          type: "welcome",
          version: this.deps.daemon.version,
          pid: process.pid,
        });
        this.deps.onHello?.(this);
        return;
      }
      case "drain": {
        this.sendControl({ type: "draining" });
        this.deps.onDrainRequested?.();
        return;
      }
      case "status": {
        this.sendControl({
          type: "status-reply",
          status: (await this.deps.buildStatus?.()) ?? null,
        });
        return;
      }
      default:
        this.deps.daemon.logger.log("warn", "connection.unexpected_control", {
          connection: this.id,
          controlType: control.type,
        });
    }
  }
}
