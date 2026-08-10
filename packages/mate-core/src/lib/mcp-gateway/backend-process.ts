import { spawn, type ChildProcess } from "node:child_process";

import type { CompanionMcpServer } from "./companion-mcp-config";
import { createLineReader } from "./frames";
import type { McpToolDescriptor } from "./tool-namespace";

const BACKEND_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One spawned stdio MCP backend: NDJSON JSON-RPC client with an initialize
 * handshake. Companion config (auth included) is passed through verbatim.
 */
export class BackendProcess {
  readonly server: CompanionMcpServer;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private exited = false;
  private exitListeners: Array<() => void> = [];
  private notificationListeners: Array<(method: string, params: unknown) => void> = [];

  private constructor(server: CompanionMcpServer, requestTimeoutMs: number) {
    this.server = server;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = spawn(server.command, server.args, {
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on(
      "data",
      createLineReader((line) => this.handleLine(line)),
    );
    this.child.stderr?.resume();
    this.child.on("exit", () => this.handleExit());
    this.child.on("error", () => this.handleExit());
  }

  static async start(
    server: CompanionMcpServer,
    options: { requestTimeoutMs?: number } = {},
  ): Promise<BackendProcess> {
    const backend = new BackendProcess(
      server,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    await backend.request("initialize", {
      protocolVersion: BACKEND_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mate-gateway", version: "1.0" },
    });
    backend.notify("notifications/initialized");
    return backend;
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onExit(listener: () => void): void {
    if (this.exited) {
      listener();
      return;
    }
    this.exitListeners.push(listener);
  }

  onNotification(listener: (method: string, params: unknown) => void): void {
    this.notificationListeners.push(listener);
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list")) as { tools?: McpToolDescriptor[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`backend ${this.server.name} is not running`));
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`backend ${this.server.name}: ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exited) return;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }

  private handleLine(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      for (const listener of this.notificationListeners) {
        listener(message.method, message.params);
      }
    }
  }

  private handleExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`backend ${this.server.name} exited`));
    }
    this.pending.clear();
    for (const listener of this.exitListeners.splice(0)) listener();
  }
}
