import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import type { CompanionMcpServer } from "./companion-mcp-config";
import { serverConfigHash } from "./config-hash";
import {
  createLineReader,
  encodeControl,
  encodeRpc,
  parseFrame,
  type GatewayFrame,
} from "./frames";
import { createGateway, type Gateway } from "./gateway";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";
import { GlobalConfigStore } from "../orchestrator/global-config-store";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

function expectedServer(name: string, command: string, companion: string): CompanionMcpServer {
  return { name, command, args: [], env: {}, cwd: companion, isolation: "shared", enabled: true };
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

  async hello(cwd: string): Promise<void> {
    this.socket.write(encodeControl({ type: "hello", version: "1.0.0", cwd }));
    await this.waitFor((frame) => frame.kind === "control" && frame.control.type === "welcome");
  }

  async toolsList(id: number): Promise<string[]> {
    this.socket.write(encodeRpc({ jsonrpc: "2.0", id, method: "tools/list" }));
    const frame = await this.waitFor(
      (candidate) => candidate.kind === "rpc" && candidate.message.id === id,
    );
    if (frame.kind !== "rpc") throw new Error("unreachable");
    return ((frame.message.result as { tools: Array<{ name: string }> }).tools ?? []).map(
      (tool) => tool.name,
    );
  }

  listChangedCount(): number {
    return this.frames.filter(
      (frame) =>
        frame.kind === "rpc" && frame.message.method === "notifications/tools/list_changed",
    ).length;
  }

  async waitFor(
    predicate: (frame: GatewayFrame) => boolean,
    timeoutMs = 5000,
  ): Promise<GatewayFrame> {
    const start = Date.now();
    let scanned = 0;
    for (;;) {
      while (scanned < this.frames.length) {
        const frame = this.frames[scanned++]!;
        if (predicate(frame)) return frame;
      }
      if (Date.now() - start > timeoutMs) throw new Error("waitFor frame timed out");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

interface World {
  root: string;
  gateway: Gateway;
  paths: ReturnType<typeof gatewayPaths>;
  companionA: string;
  companionB: string;
  repoOne: string;
  repoTwo: string;
}

async function makeWorld(): Promise<World> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gwprop-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

  const companionA = path.join(root, "companions", "acme");
  const companionB = path.join(root, "companions", "other");
  for (const [companion, serverName, command] of [
    [companionA, "alpha-mcp", "alpha-bin"],
    [companionB, "beta-mcp", "beta-bin"],
  ] as const) {
    await fs.mkdir(path.join(companion, ".mate"), { recursive: true });
    await fs.writeFile(
      path.join(companion, ".mate", "mcp.yaml"),
      ["servers:", `  ${serverName}:`, `    command: ${command}`].join("\n"),
      "utf8",
    );
  }

  const repoOne = path.join(root, "repos", "one");
  const repoTwo = path.join(root, "repos", "two");
  await fs.mkdir(path.join(repoOne, ".mate", "config"), { recursive: true });
  await fs.mkdir(path.join(repoTwo, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(repoOne, ".mate", "config", "registry.yaml"),
    stringify({
      companions: [
        { path: companionA, repositoryId: "one" },
        { path: companionB, repositoryId: "one" },
      ],
      selectedCompanionPath: companionA,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(repoTwo, ".mate", "config", "registry.yaml"),
    stringify({ companions: [{ path: companionA, repositoryId: "two" }] }),
    "utf8",
  );

  const globalConfigPath = path.join(root, "config.yaml");
  await fs.writeFile(
    globalConfigPath,
    stringify({ version: 1, companions: [{ path: companionA }, { path: companionB }] }),
    "utf8",
  );

  const mateHome = path.join(root, "mate-home");
  const paths = gatewayPaths(mateHome);
  const gateway = createGateway({
    version: "1.0.0",
    paths,
    idleShutdownMs: Infinity,
    watchDebounceMs: 30,
    logger: NULL_GATEWAY_LOGGER,
    globalConfigStore: new GlobalConfigStore(globalConfigPath),
  });
  /* Pre-seed manifests so tools/list never spawns the fake binaries. */
  await gateway.cache.set(
    serverConfigHash(expectedServer("alpha-mcp", "alpha-bin", companionA)),
    [{ name: "alpha-tool" }],
    "alpha-bin",
  );
  await gateway.cache.set(
    serverConfigHash(expectedServer("beta-mcp", "beta-bin", companionB)),
    [{ name: "beta-tool" }],
    "beta-bin",
  );
  await gateway.start();
  cleanups.push(async () => gateway.stop());

  return { root, gateway, paths, companionA, companionB, repoOne, repoTwo };
}

describe("change propagation (5.1, 5.2)", () => {
  test("repin swaps tools and notifies exactly the affected connection; config edits hot-reload", async () => {
    const world = await makeWorld();

    const clientOne = new TestClient();
    await clientOne.connect(world.paths.socketPath);
    await clientOne.hello(world.repoOne);
    const clientTwo = new TestClient();
    await clientTwo.connect(world.paths.socketPath);
    await clientTwo.hello(world.repoTwo);

    expect(await clientOne.toolsList(1)).toEqual(["mate__alpha-tool"]);
    expect(await clientTwo.toolsList(1)).toEqual(["mate__alpha-tool"]);

    /* --- pin flip on repo one only --- */
    await fs.writeFile(
      path.join(world.repoOne, ".mate", "config", "registry.yaml"),
      stringify({
        companions: [
          { path: world.companionA, repositoryId: "one" },
          { path: world.companionB, repositoryId: "one" },
        ],
        selectedCompanionPath: world.companionB,
      }),
      "utf8",
    );

    await clientOne.waitFor(
      (frame) =>
        frame.kind === "rpc" && frame.message.method === "notifications/tools/list_changed",
    );
    expect(await clientOne.toolsList(2)).toEqual(["mate__beta-tool"]);
    /* the untouched repo's connection saw no notification and keeps its tools */
    expect(clientTwo.listChangedCount()).toBe(0);
    expect(await clientTwo.toolsList(2)).toEqual(["mate__alpha-tool"]);

    /* --- companion MCP config edit hot-reloads the affected connection --- */
    const gammaServer = expectedServer("gamma-mcp", "gamma-bin", world.companionB);
    await world.gateway.cache.set(
      serverConfigHash(gammaServer),
      [{ name: "gamma-tool" }],
      "gamma-bin",
    );
    await fs.writeFile(
      path.join(world.companionB, ".mate", "mcp.yaml"),
      [
        "servers:",
        "  beta-mcp:",
        "    command: beta-bin",
        "  gamma-mcp:",
        "    command: gamma-bin",
      ].join("\n"),
      "utf8",
    );

    await clientOne.waitFor(() => clientOne.listChangedCount() >= 2);
    expect((await clientOne.toolsList(3)).sort()).toEqual(["mate__beta-tool", "mate__gamma-tool"]);
    expect(clientTwo.listChangedCount()).toBe(0);
  }, 15000);

  test("defensive re-resolve on tools/list catches changes even without watch events", async () => {
    const world = await makeWorld();
    const client = new TestClient();
    await client.connect(world.paths.socketPath);
    await client.hello(world.repoTwo);
    expect(await client.toolsList(1)).toEqual(["mate__alpha-tool"]);

    /* stop watchers to simulate missed fs events, then repin repo two */
    world.gateway.watcher.stop();
    await fs.writeFile(
      path.join(world.repoTwo, ".mate", "config", "registry.yaml"),
      stringify({
        companions: [{ path: world.companionB, repositoryId: "two" }],
        selectedCompanionPath: world.companionB,
      }),
      "utf8",
    );

    expect(await client.toolsList(2)).toEqual(["mate__beta-tool"]);
  }, 15000);
});
