import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { BackendSupervisor } from "./backend-supervisor";
import type { CompanionMcpServer } from "./companion-mcp-config";
import { serverConfigHash } from "./config-hash";
import type { GatewayConnection } from "./connection";
import { ManifestCache } from "./manifest-cache";

const FIXTURE = path.join(import.meta.dir, "fixtures", "fixture-mcp-server.mjs");

const tempRoots: string[] = [];
const supervisors: BackendSupervisor[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backend-sup-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function fixtureServer(
  cwd: string,
  overrides: Partial<CompanionMcpServer> & {
    tools?: string[];
    extraEnv?: Record<string, string>;
  } = {},
): CompanionMcpServer {
  const { tools, extraEnv, ...serverOverrides } = overrides;
  return {
    name: "fixture",
    command: process.execPath,
    args: [FIXTURE],
    env: {
      FIXTURE_TOOLS: JSON.stringify(tools ?? ["alpha"]),
      ...extraEnv,
    },
    cwd,
    isolation: "shared",
    enabled: true,
    ...serverOverrides,
  };
}

function makeSupervisor(
  cache: ManifestCache,
  options: Partial<ConstructorParameters<typeof BackendSupervisor>[0]> = {},
): BackendSupervisor {
  const supervisor = new BackendSupervisor({
    cache,
    idleTtlMs: Infinity,
    requestTimeoutMs: 5000,
    ...options,
  });
  supervisors.push(supervisor);
  return supervisor;
}

function connection(id: number): GatewayConnection {
  return { id } as unknown as GatewayConnection;
}

async function readSpawnLog(logPath: string): Promise<string[]> {
  try {
    return (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function callText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("manifest-cached tools/list (4.1)", () => {
  test("cache hit serves tools without spawning", async () => {
    const dir = await makeTempDir();
    const spawnLog = path.join(dir, "spawns.log");
    const server = fixtureServer(dir, { extraEnv: { FIXTURE_SPAWN_LOG: spawnLog } });
    const cache = new ManifestCache(path.join(dir, "manifests.json"));
    await cache.set(serverConfigHash(server), [{ name: "cached-tool" }], "fixture");
    const supervisor = makeSupervisor(cache);

    const tools = await supervisor.listTools(server, connection(1));

    expect(tools).toEqual([{ name: "cached-tool" }]);
    expect(await readSpawnLog(spawnLog)).toEqual([]);
  });

  test("first-ever config spawns once to learn the manifest and caches it", async () => {
    const dir = await makeTempDir();
    const spawnLog = path.join(dir, "spawns.log");
    const server = fixtureServer(dir, {
      tools: ["alpha", "beta"],
      extraEnv: { FIXTURE_SPAWN_LOG: spawnLog },
    });
    const cache = new ManifestCache(path.join(dir, "manifests.json"));
    const supervisor = makeSupervisor(cache);

    const tools = await supervisor.listTools(server, connection(1));

    expect(tools.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(await readSpawnLog(spawnLog)).toHaveLength(1);
    expect((await cache.get(serverConfigHash(server)))?.tools.map((t) => t.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("backend lifecycle (4.2)", () => {
  test("first tools/call spawns the backend and forwards the call", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir);
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));

    const result = await supervisor.callTool(server, "alpha", {}, connection(1));

    expect(callText(result)).toMatch(/^alpha:\d+$/);
    expect(await supervisor.status()).toHaveLength(1);
  });

  test("idle TTL reaps the backend while the manifest survives", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir);
    const cache = new ManifestCache(path.join(dir, "manifests.json"));
    const supervisor = makeSupervisor(cache, { idleTtlMs: 100 });

    await supervisor.callTool(server, "alpha", {}, connection(1));
    await waitFor(async () => (await supervisor.status()).length === 0);

    expect(await cache.get(serverConfigHash(server))).toBeDefined();
    /* cached manifest still answers tools/list with zero processes */
    expect((await supervisor.listTools(server, connection(1))).map((t) => t.name)).toEqual([
      "alpha",
    ]);
    expect(await supervisor.status()).toHaveLength(0);
  });

  test("a backend that crashes mid-call is respawned and the call retried", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, {
      extraEnv: { FIXTURE_CRASH_ONCE_FILE: path.join(dir, "crash-once") },
    });
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));

    const result = await supervisor.callTool(server, "alpha", {}, connection(1));

    expect(callText(result)).toMatch(/^alpha:\d+$/);
  });

  test("consecutive spawn failures hit the crash cap with a clear error", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, {
      command: path.join(dir, "does-not-exist"),
      args: [],
    });
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")), {
      maxConsecutiveCrashes: 2,
    });

    await expect(supervisor.callTool(server, "alpha", {}, connection(1))).rejects.toThrow();
    await expect(supervisor.callTool(server, "alpha", {}, connection(1))).rejects.toThrow();
    await expect(supervisor.callTool(server, "alpha", {}, connection(1))).rejects.toThrow(
      /not respawning/,
    );
  });

  test("backend JSON-RPC errors surface without killing the backend", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, {
      tools: ["alpha", "bad"],
      extraEnv: { FIXTURE_FAIL_TOOL: "bad" },
    });
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));

    await expect(supervisor.callTool(server, "bad", {}, connection(1))).rejects.toThrow(
      /fixture failure/,
    );
    expect(callText(await supervisor.callTool(server, "alpha", {}, connection(1)))).toMatch(
      /^alpha:\d+$/,
    );
    expect(await supervisor.status()).toHaveLength(1);
  });
});

describe("schema drift (4.3)", () => {
  test("spawn refreshes a stale manifest and notifies", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, { tools: ["alpha", "beta"] });
    const cache = new ManifestCache(path.join(dir, "manifests.json"));
    await cache.set(serverConfigHash(server), [{ name: "alpha" }], "fixture");
    const changed: string[] = [];
    const supervisor = makeSupervisor(cache, {
      onManifestChanged: (configHash) => changed.push(configHash),
    });

    await supervisor.callTool(server, "alpha", {}, connection(1));
    await waitFor(() => changed.length > 0);

    expect(changed).toEqual([serverConfigHash(server)]);
    expect((await cache.get(serverConfigHash(server)))?.tools.map((t) => t.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("a matching manifest does not notify", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, { tools: ["alpha"] });
    const cache = new ManifestCache(path.join(dir, "manifests.json"));
    const changed: string[] = [];
    const supervisor = makeSupervisor(cache, {
      onManifestChanged: (configHash) => changed.push(configHash),
    });
    /* first use fills the cache */
    await supervisor.listTools(server, connection(1));
    await supervisor.stopAll();

    const fresh = makeSupervisor(cache, {
      onManifestChanged: (configHash) => changed.push(configHash),
    });
    await fresh.callTool(server, "alpha", {}, connection(1));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(changed).toEqual([]);
  });
});

describe("backend sharing and isolation (4.4)", () => {
  test("shared servers serve two connections from one process", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir);
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));

    const first = callText(await supervisor.callTool(server, "alpha", {}, connection(1)));
    const second = callText(await supervisor.callTool(server, "alpha", {}, connection(2)));

    expect(first).toBe(second);
    expect(await supervisor.status()).toHaveLength(1);
  });

  test("isolation: connection gives each connection its own process", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, { isolation: "connection" });
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));

    const first = callText(await supervisor.callTool(server, "alpha", {}, connection(1)));
    const second = callText(await supervisor.callTool(server, "alpha", {}, connection(2)));

    expect(first).not.toBe(second);
    expect(await supervisor.status()).toHaveLength(2);
  });

  test("releaseConnection reaps only that connection's isolated backend", async () => {
    const dir = await makeTempDir();
    const server = fixtureServer(dir, { isolation: "connection" });
    const supervisor = makeSupervisor(new ManifestCache(path.join(dir, "manifests.json")));
    await supervisor.callTool(server, "alpha", {}, connection(1));
    await supervisor.callTool(server, "alpha", {}, connection(2));

    supervisor.releaseConnection(1);
    await waitFor(async () => (await supervisor.status()).length === 1);

    expect((await supervisor.status())[0]!.connectionId).toBe(2);
  });
});
