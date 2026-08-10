import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { readGatewayState } from "./daemon";
import {
  createLineReader,
  encodeControl,
  encodeRpc,
  parseFrame,
  type GatewayFrame,
} from "./frames";
import { GatewayRuntime } from "./gateway";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

function makeRuntime(paths: ReturnType<typeof gatewayPaths>, version: string): GatewayRuntime {
  const runtime = new GatewayRuntime({
    version,
    paths,
    idleShutdownMs: Infinity,
    logger: NULL_GATEWAY_LOGGER,
    resolver: {
      async resolveConnection() {
        return { repoRoot: "/repos/acme", companionPath: "/companions/acme", servers: [] };
      },
    },
    toolSource: {
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    },
  });
  cleanups.push(async () => runtime.stop());
  return runtime;
}

class TestClient {
  socket!: net.Socket;
  readonly frames: GatewayFrame[] = [];
  private waiters: Array<() => void> = [];

  async connect(socketPath: string): Promise<void> {
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    this.socket.on(
      "data",
      createLineReader((line) => {
        this.frames.push(parseFrame(line));
        for (const waiter of this.waiters.splice(0)) waiter();
      }),
    );
    cleanups.push(async () => this.socket.destroy());
  }

  async nextFrame(count = 1): Promise<GatewayFrame> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.frames[count - 1]!;
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("gateway drain and takeover", () => {
  test("drain unlinks the socket, keeps serving live connections, and exits after the last one", async () => {
    const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwdrain-"));
    cleanups.push(async () => fs.rm(mateHome, { recursive: true, force: true }));
    const paths = gatewayPaths(mateHome);
    const oldRuntime = makeRuntime(paths, "1.0.0");
    await oldRuntime.start();

    const session = new TestClient();
    await session.connect(paths.socketPath);
    session.socket.write(encodeControl({ type: "hello", version: "1.0.0", cwd: "/repos/acme" }));
    await session.nextFrame();

    const drainer = new TestClient();
    await drainer.connect(paths.socketPath);
    drainer.socket.write(encodeControl({ type: "drain" }));
    const ack = await drainer.nextFrame();
    expect(ack).toEqual({ kind: "control", control: { type: "draining" } });
    drainer.socket.destroy();

    await waitFor(async () => {
      try {
        await fs.access(paths.socketPath);
        return false;
      } catch {
        return true;
      }
    });

    /* the drained daemon still serves the live session */
    session.socket.write(encodeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const reply = await session.nextFrame(2);
    expect(reply).toEqual({
      kind: "rpc",
      message: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    });

    /* a new-version daemon takes over the socket path while the old one drains */
    const newRuntime = makeRuntime(paths, "2.0.0");
    await newRuntime.start();
    const fresh = new TestClient();
    await fresh.connect(paths.socketPath);
    fresh.socket.write(encodeControl({ type: "hello", version: "2.0.0", cwd: "/repos/acme" }));
    const welcome = await fresh.nextFrame();
    expect(welcome).toMatchObject({
      kind: "control",
      control: { type: "welcome", version: "2.0.0" },
    });
    expect((await readGatewayState(paths.statePath))?.version).toBe("2.0.0");

    /* the old daemon exits once its last connection closes */
    session.socket.destroy();
    await oldRuntime.daemon.whenStopped;
    /* takeover state file belongs to the new daemon and must survive the old one's exit */
    expect((await readGatewayState(paths.statePath))?.version).toBe("2.0.0");
  });
});
