import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GatewayConnection, type ConnectionResolution } from "./connection";
import { GatewayDaemon } from "./daemon";
import {
  createLineReader,
  encodeControl,
  encodeRpc,
  parseFrame,
  type GatewayFrame,
} from "./frames";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

interface Harness {
  paths: ReturnType<typeof gatewayPaths>;
  daemon: GatewayDaemon;
  resolved: string[];
  drainRequests: number;
  helloConnections: GatewayConnection[];
  handledRpc: Array<{ method?: string }>;
}

async function startHarness(
  resolution: ConnectionResolution = { repoRoot: null, companionPath: null, servers: [] },
): Promise<Harness> {
  const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwc-"));
  const paths = gatewayPaths(mateHome);
  const harness: Partial<Harness> = {
    resolved: [],
    drainRequests: 0,
    helloConnections: [],
    handledRpc: [],
  };
  const daemon = new GatewayDaemon({
    version: "9.9.9",
    paths,
    idleShutdownMs: Infinity,
    logger: NULL_GATEWAY_LOGGER,
    connectionHandler: (socket, owner) => {
      new GatewayConnection(socket, {
        daemon: owner,
        resolver: {
          async resolveConnection(cwd) {
            harness.resolved!.push(cwd);
            return resolution;
          },
        },
        surface: {
          async handleRequest(connection, message) {
            harness.handledRpc!.push({ method: message.method });
            if (message.id !== undefined) {
              connection.sendRpc({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
            }
          },
        },
        onDrainRequested: () => {
          harness.drainRequests! += 1;
        },
        buildStatus: () => ({ marker: "status" }),
        onHello: (connection) => harness.helloConnections!.push(connection),
      });
    },
  });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.stop();
    await fs.rm(mateHome, { recursive: true, force: true });
  });
  harness.daemon = daemon;
  harness.paths = paths;
  return harness as Harness;
}

class TestClient {
  private socket!: net.Socket;
  readonly frames: GatewayFrame[] = [];
  private waiters: Array<() => void> = [];

  async connect(socketPath: string): Promise<void> {
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    const read = createLineReader((line) => {
      this.frames.push(parseFrame(line));
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.socket.on("data", read);
    cleanups.push(async () => this.socket.destroy());
  }

  write(raw: string): void {
    this.socket.write(raw);
  }

  async nextFrame(count = 1): Promise<GatewayFrame> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.frames[count - 1]!;
  }
}

describe("GatewayConnection handshake", () => {
  test("hello resolves the cwd and answers welcome with daemon version and pid", async () => {
    const harness = await startHarness({
      repoRoot: "/repos/acme",
      companionPath: "/companions/acme",
      servers: [],
    });
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);

    client.write(encodeControl({ type: "hello", version: "1.2.3", cwd: "/repos/acme/src" }));

    const frame = await client.nextFrame();
    expect(frame).toEqual({
      kind: "control",
      control: { type: "welcome", version: "9.9.9", pid: process.pid },
    });
    expect(harness.resolved).toEqual(["/repos/acme/src"]);
    const connection = harness.helloConnections[0]!;
    expect(connection.clientVersion).toBe("1.2.3");
    expect(connection.cwd).toBe("/repos/acme/src");
    expect(connection.resolution.companionPath).toBe("/companions/acme");
  });

  test("JSON-RPC before hello is rejected with an error response", async () => {
    const harness = await startHarness();
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);

    client.write(encodeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    const frame = await client.nextFrame();
    expect(frame.kind).toBe("rpc");
    if (frame.kind === "rpc") {
      expect(frame.message.error?.message).toContain("hello handshake required");
    }
    expect(harness.handledRpc).toEqual([]);
  });

  test("after hello, JSON-RPC frames reach the MCP surface", async () => {
    const harness = await startHarness();
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);
    client.write(encodeControl({ type: "hello", version: "1.0.0", cwd: "/anywhere" }));
    await client.nextFrame();

    client.write(encodeRpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }));

    const frame = await client.nextFrame(2);
    expect(frame).toEqual({
      kind: "rpc",
      message: { jsonrpc: "2.0", id: 7, result: { ok: true } },
    });
    expect(harness.handledRpc).toEqual([{ method: "tools/list" }]);
  });

  test("drain control acks and forwards the request", async () => {
    const harness = await startHarness();
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);

    client.write(encodeControl({ type: "drain" }));

    const frame = await client.nextFrame();
    expect(frame).toEqual({ kind: "control", control: { type: "draining" } });
    expect(harness.drainRequests).toBe(1);
  });

  test("status control replies with the daemon status payload", async () => {
    const harness = await startHarness();
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);

    client.write(encodeControl({ type: "status" }));

    const frame = await client.nextFrame();
    expect(frame).toEqual({
      kind: "control",
      control: { type: "status-reply", status: { marker: "status" } },
    });
  });

  test("garbage lines are ignored and the connection stays usable", async () => {
    const harness = await startHarness();
    const client = new TestClient();
    await client.connect(harness.paths.socketPath);

    client.write("not json at all\n");
    client.write(encodeControl({ type: "hello", version: "1.0.0", cwd: "/x" }));

    const frame = await client.nextFrame();
    expect(frame.kind).toBe("control");
    expect(harness.resolved).toEqual(["/x"]);
  });

  test("failed resolution falls back to an inactive connection instead of dying", async () => {
    const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwc-fail-"));
    const paths = gatewayPaths(mateHome);
    const helloConnections: GatewayConnection[] = [];
    const daemon = new GatewayDaemon({
      version: "9.9.9",
      paths,
      idleShutdownMs: Infinity,
      logger: NULL_GATEWAY_LOGGER,
      connectionHandler: (socket, owner) => {
        new GatewayConnection(socket, {
          daemon: owner,
          resolver: {
            async resolveConnection() {
              throw new Error("registry unreadable");
            },
          },
          surface: { async handleRequest() {} },
          onHello: (connection) => helloConnections.push(connection),
        });
      },
    });
    await daemon.start();
    cleanups.push(async () => {
      await daemon.stop();
      await fs.rm(mateHome, { recursive: true, force: true });
    });
    const client = new TestClient();
    await client.connect(paths.socketPath);

    client.write(encodeControl({ type: "hello", version: "1.0.0", cwd: "/broken" }));

    const frame = await client.nextFrame();
    expect(frame.kind).toBe("control");
    expect(helloConnections[0]!.resolution).toEqual({
      repoRoot: null,
      companionPath: null,
      servers: [],
    });
  });
});
