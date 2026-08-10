import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import { GlobalConfigStore } from "../orchestrator/global-config-store";
import { GatewayConnectionResolver } from "./gateway-resolver";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface World {
  resolver: GatewayConnectionResolver;
  globalConfigPath: string;
  root: string;
}

async function makeWorld(): Promise<World> {
  const root = await makeTempDir("gwr-");
  const globalConfigPath = path.join(root, "config.yaml");
  return {
    resolver: new GatewayConnectionResolver({
      globalConfigStore: new GlobalConfigStore(globalConfigPath),
    }),
    globalConfigPath,
    root,
  };
}

async function trustCompanions(world: World, companionPaths: string[]): Promise<void> {
  await fs.writeFile(
    world.globalConfigPath,
    stringify({ version: 1, companions: companionPaths.map((p) => ({ path: p })) }),
    "utf8",
  );
}

async function makeCompanion(world: World, name: string, mcpYaml?: string): Promise<string> {
  const companion = path.join(world.root, "companions", name);
  await fs.mkdir(companion, { recursive: true });
  if (mcpYaml !== undefined) {
    await fs.mkdir(path.join(companion, ".mate"), { recursive: true });
    await fs.writeFile(path.join(companion, ".mate", "mcp.yaml"), mcpYaml, "utf8");
  }
  return companion;
}

async function makeRepo(world: World, name: string, companionPath: string): Promise<string> {
  const repo = path.join(world.root, "repos", name);
  await fs.mkdir(path.join(repo, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(repo, ".mate", "config", "registry.yaml"),
    stringify({ companions: [{ path: companionPath, repositoryId: name }] }),
    "utf8",
  );
  return repo;
}

describe("GatewayConnectionResolver", () => {
  test("two connections resolve to different companions with their own servers", async () => {
    const world = await makeWorld();
    const companionA = await makeCompanion(
      world,
      "acme",
      ["servers:", "  alpha-mcp:", "    command: alpha"].join("\n"),
    );
    const companionB = await makeCompanion(
      world,
      "other",
      ["servers:", "  beta-mcp:", "    command: beta"].join("\n"),
    );
    await trustCompanions(world, [companionA, companionB]);
    const repoA = await makeRepo(world, "repo-a", companionA);
    const repoB = await makeRepo(world, "repo-b", companionB);

    const resolutionA = await world.resolver.resolveConnection(path.join(repoA, "src"));
    const resolutionB = await world.resolver.resolveConnection(repoB);

    expect(resolutionA.repoRoot).toBe(repoA);
    expect(resolutionA.companionPath).toBe(companionA);
    expect(resolutionA.servers.map((server) => server.name)).toEqual(["alpha-mcp"]);
    expect(resolutionB.repoRoot).toBe(repoB);
    expect(resolutionB.companionPath).toBe(companionB);
    expect(resolutionB.servers.map((server) => server.name)).toEqual(["beta-mcp"]);
  });

  test("an unlinked directory is inactive: no repo root, no companion, no servers", async () => {
    const world = await makeWorld();
    const plain = path.join(world.root, "plain");
    await fs.mkdir(plain, { recursive: true });

    expect(await world.resolver.resolveConnection(plain)).toEqual({
      repoRoot: null,
      companionPath: null,
      servers: [],
    });
  });

  test("an untrusted repo-local pointer yields an inactive connection with the repo root", async () => {
    const world = await makeWorld();
    const companion = await makeCompanion(world, "acme");
    const repo = await makeRepo(world, "repo-a", companion);
    /* companion exists but is not in the global registry — the trust gate must hold */

    const resolution = await world.resolver.resolveConnection(repo);

    expect(resolution.repoRoot).toBe(repo);
    expect(resolution.companionPath).toBeNull();
    expect(resolution.servers).toEqual([]);
  });

  test("a linked repo whose companion has no MCP config resolves with an empty server set", async () => {
    const world = await makeWorld();
    const companion = await makeCompanion(world, "acme");
    await trustCompanions(world, [companion]);
    const repo = await makeRepo(world, "repo-a", companion);

    const resolution = await world.resolver.resolveConnection(repo);

    expect(resolution.companionPath).toBe(companion);
    expect(resolution.servers).toEqual([]);
  });

  test("disabled servers are excluded from the connection tool source", async () => {
    const world = await makeWorld();
    const companion = await makeCompanion(
      world,
      "acme",
      [
        "servers:",
        "  on-mcp:",
        "    command: on",
        "  off-mcp:",
        "    command: off",
        "    enabled: false",
      ].join("\n"),
    );
    await trustCompanions(world, [companion]);
    const repo = await makeRepo(world, "repo-a", companion);

    const resolution = await world.resolver.resolveConnection(repo);

    expect(resolution.servers.map((server) => server.name)).toEqual(["on-mcp"]);
  });

  test("the pin decides between ambiguous companions", async () => {
    const world = await makeWorld();
    const companionA = await makeCompanion(world, "acme");
    const companionB = await makeCompanion(
      world,
      "other",
      ["servers:", "  pinned-mcp:", "    command: pinned"].join("\n"),
    );
    await trustCompanions(world, [companionA, companionB]);
    const repo = path.join(world.root, "repos", "shared");
    await fs.mkdir(path.join(repo, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".mate", "config", "registry.yaml"),
      stringify({
        companions: [
          { path: companionA, repositoryId: "shared" },
          { path: companionB, repositoryId: "shared" },
        ],
        selectedCompanionPath: companionB,
      }),
      "utf8",
    );

    const resolution = await world.resolver.resolveConnection(repo);

    expect(resolution.companionPath).toBe(companionB);
    expect(resolution.servers.map((server) => server.name)).toEqual(["pinned-mcp"]);
  });
});
