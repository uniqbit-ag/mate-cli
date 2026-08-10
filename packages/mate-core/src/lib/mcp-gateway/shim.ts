import net from "node:net";
import type { Readable, Writable } from "node:stream";

import { socketIsAlive } from "./daemon";
import { createLineReader, encodeControl, parseFrame } from "./frames";
import type { GatewayLogger } from "./gateway-log";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths, type GatewayPaths } from "./gateway-paths";

export interface ShimOptions {
  version: string;
  cwd: string;
  paths?: GatewayPaths;
  input?: Readable;
  output?: Writable;
  /** Detached daemon starter; injected in tests, CLI re-invokes itself. */
  spawnDaemon: () => Promise<void>;
  logger?: GatewayLogger;
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_DELAY_MS = 100;

function connectOnce(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectWithAutostart(
  socketPath: string,
  spawnDaemon: () => Promise<void>,
  timeoutMs: number,
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let spawned = false;
  for (;;) {
    try {
      return await connectOnce(socketPath);
    } catch {
      if (!spawned) {
        spawned = true;
        await spawnDaemon();
      }
      if (Date.now() > deadline) {
        throw new Error(`mate MCP gateway daemon did not come up on ${socketPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

interface HandshakeResult {
  socket: net.Socket;
  daemonVersion: string;
  /** Frames that arrived bundled with the welcome — forwarded to the host. */
  earlyLines: string[];
}

function handshake(socket: net.Socket, version: string, cwd: string): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const earlyLines: string[] = [];
    let settled = false;
    const read = createLineReader((line) => {
      if (settled) {
        earlyLines.push(line);
        return;
      }
      const frame = parseFrame(line);
      if (frame.kind === "control" && frame.control.type === "welcome") {
        settled = true;
        socket.off("data", read);
        resolve({ socket, daemonVersion: frame.control.version, earlyLines });
      }
    });
    socket.on("data", read);
    socket.once("error", (error) => {
      if (!settled) reject(error);
    });
    socket.once("close", () => {
      if (!settled) reject(new Error("gateway closed during handshake"));
    });
    socket.write(encodeControl({ type: "hello", version, cwd }));
  });
}

/** Ask the stale daemon to drain, then wait for the socket to free up. */
async function drainStaleDaemon(socketPath: string, timeoutMs: number): Promise<void> {
  const socket = await connectOnce(socketPath);
  await new Promise<void>((resolve) => {
    const read = createLineReader((line) => {
      const frame = parseFrame(line);
      if (frame.kind === "control" && frame.control.type === "draining") {
        socket.destroy();
        resolve();
      }
    });
    socket.on("data", read);
    socket.once("close", () => resolve());
    socket.write(encodeControl({ type: "drain" }));
  });
  const deadline = Date.now() + timeoutMs;
  while (await socketIsAlive(socketPath)) {
    if (Date.now() > deadline) throw new Error("stale gateway daemon did not release the socket");
    await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
  }
}

/**
 * `mate mcp shim`: the stdio MCP server every host registers. Connects to the
 * gateway socket (auto-starting the daemon), performs the version handshake
 * (drain-and-replace on skew), then pipes MCP frames verbatim. Exits when the
 * host closes stdin or the daemon connection drops.
 */
export async function runShim(options: ShimOptions): Promise<void> {
  const paths = options.paths ?? gatewayPaths();
  const logger = options.logger ?? NULL_GATEWAY_LOGGER;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let socket = await connectWithAutostart(paths.socketPath, options.spawnDaemon, timeoutMs);
  let result = await handshake(socket, options.version, options.cwd);

  if (result.daemonVersion !== options.version) {
    logger.log("info", "shim.version_skew", {
      daemonVersion: result.daemonVersion,
      shimVersion: options.version,
    });
    socket.destroy();
    await drainStaleDaemon(paths.socketPath, timeoutMs);
    socket = await connectWithAutostart(paths.socketPath, options.spawnDaemon, timeoutMs);
    result = await handshake(socket, options.version, options.cwd);
  }

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };

    /* daemon → host: forward MCP frames, swallow gateway control frames */
    const forward = (line: string) => {
      const frame = parseFrame(line);
      if (frame.kind === "control") return;
      output.write(`${line}\n`);
    };
    for (const line of result.earlyLines) forward(line);
    socket.on("data", createLineReader(forward));
    socket.once("close", finish);
    socket.once("error", finish);

    /* host → daemon: verbatim */
    input.on("data", (chunk: Buffer | string) => {
      socket.write(chunk);
    });
    input.once("end", finish);
    input.once("close", finish);
  });
}
