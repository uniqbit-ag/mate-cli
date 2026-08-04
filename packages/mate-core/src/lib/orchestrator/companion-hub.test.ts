import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  addHubMember,
  defaultGitCommand,
  discoverGitSource,
  discoverHubSource,
  initializeCompanionHub,
  materializeHubMember,
  syncHub,
  updateHubPlugins,
} from "./companion-hub";
import { ConfigStore } from "./config-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout).trim();
}

async function writeCompanion(root: string, name = "child"): Promise<string> {
  const companion = path.join(root, name);
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    "type: companion\nallowedAgents: []\n",
    "utf8",
  );
  await fs.writeFile(path.join(companion, "notes.md"), "initial\n", "utf8");
  return companion;
}

async function makeGitCompanion(root: string): Promise<{ remote: string; source: string }> {
  const remote = path.join(root, "origin.git");
  const source = path.join(root, "source");
  git(root, "init", "--bare", remote);
  await writeCompanion(root, "source");
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "test@example.test");
  git(source, "config", "user.name", "Test");
  git(source, "remote", "add", "origin", remote);
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  git(source, "push", "-u", "origin", "main");
  return { remote, source };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("companion hub lifecycle", () => {
  test("initializes an existing folder without creating Git metadata", async () => {
    const root = await makeTempDir("hub-init-");
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n", "utf8");

    await initializeCompanionHub(root);

    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep\n");
    expect(
      await fs.readFile(path.join(root, ".mate", "config", "framework.yaml"), "utf8"),
    ).toContain("type: hub");
    const config = await new ConfigStore(
      path.join(root, ".mate", "config", "framework.yaml"),
    ).load();
    expect(config.allowedAgents).toEqual([]);
    expect(config.packageManagers).toEqual([]);
    expect(config.capabilities).toEqual([]);
    expect(config.hub).toEqual({ companions: [] });
    expect(await fs.stat(path.join(root, ".git")).catch(() => null)).toBeNull();
  });

  test("does not initialize a hub inside a linked working repository", async () => {
    const root = await makeTempDir("hub-linked-repo-");
    await fs.mkdir(path.join(root, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".mate", "config", "registry.yaml"),
      `repository:\n  id: product\n  path: ${root}\n  profile: default\ncompanions: []\n`,
      "utf8",
    );

    await expect(initializeCompanionHub(root)).rejects.toThrow("linked working repository");
    expect(
      await fs.stat(path.join(root, ".mate", "config", "framework.yaml")).catch(() => null),
    ).toBeNull();
  });

  test("copies a registered local-only companion without its source Git directory", async () => {
    const root = await makeTempDir("hub-local-");
    const source = await writeCompanion(root, "source");
    await fs.mkdir(path.join(source, ".git"));
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);

    const member = await addHubMember(hub, discoverHubSource(source));

    expect(member.source.kind).toBe("local");
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("initial\n");
    expect(await fs.stat(path.join(hub, member.path, ".git")).catch(() => null)).toBeNull();
  });

  test("clones a Git-backed companion and records its commit", async () => {
    const root = await makeTempDir("hub-git-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);

    const member = await addHubMember(hub, discoverGitSource(source));

    expect(member.source.kind).toBe("git");
    expect(member.materializedCommit).toBeTruthy();
    expect(await fs.stat(path.join(hub, member.path, ".git")).catch(() => null)).not.toBeNull();
    expect(git(path.join(hub, member.path), "rev-parse", "--show-toplevel")).toBe(
      await fs.realpath(path.join(hub, member.path)),
    );
  });

  test("removes a failed clone destination", async () => {
    const root = await makeTempDir("hub-failed-clone-");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);
    const failingGit = () => ({ status: 1, stdout: "", stderr: "clone failed" });

    await expect(
      materializeHubMember(
        hub,
        { kind: "git", url: "https://example.test/acme.git" },
        { git: failingGit },
      ),
    ).rejects.toThrow("clone failed");
    expect(await fs.stat(path.join(hub, "companions", "acme")).catch(() => null)).toBeNull();
  });

  test("fast-forwards clean Git children and protects dirty children", async () => {
    const root = await makeTempDir("hub-sync-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);
    const member = await addHubMember(hub, discoverGitSource(source));

    await fs.writeFile(path.join(source, "notes.md"), "updated\n", "utf8");
    git(source, "add", "notes.md");
    git(source, "commit", "-m", "update");
    git(source, "push");

    const updated = await syncHub(hub);
    expect(updated[0]?.status).toBe("updated");
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("updated\n");

    const child = path.join(hub, member.path);
    git(child, "config", "user.email", "test@example.test");
    git(child, "config", "user.name", "Test");
    await fs.writeFile(path.join(child, "notes.md"), "local commit\n", "utf8");
    git(child, "add", "notes.md");
    git(child, "commit", "-m", "local");
    await fs.writeFile(path.join(source, "notes.md"), "remote update\n", "utf8");
    git(source, "add", "notes.md");
    git(source, "commit", "-m", "remote update");
    git(source, "push");

    const commands: string[][] = [];
    const divergent = await syncHub(hub, (cwd, args) => {
      commands.push(args);
      return defaultGitCommand(cwd, args);
    });
    expect(divergent[0]?.status).toBe("divergent");
    expect(commands.some((args) => ["push", "merge", "reset"].includes(args[0] ?? ""))).toBe(false);

    await fs.writeFile(path.join(hub, member.path, "notes.md"), "local\n", "utf8");
    const dirty = await syncHub(hub);
    expect(dirty[0]?.status).toBe("dirty");
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("local\n");
  });

  test("reports local-only members without invoking Git", async () => {
    const root = await makeTempDir("hub-local-sync-");
    const source = await writeCompanion(root, "source");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);
    await addHubMember(hub, { kind: "local", path: source });
    const calls: string[][] = [];

    const result = await syncHub(hub, (_cwd, args) => {
      calls.push(args);
      return defaultGitCommand(_cwd, args);
    });

    expect(result[0]?.status).toBe("local-only");
    expect(calls).toEqual([]);
  });

  test("updates declared hub plugins without touching child plugin workspaces", async () => {
    const root = await makeTempDir("hub-plugins-");
    const source = await writeCompanion(root, "source");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub);
    const member = await addHubMember(hub, { kind: "local", path: source });
    const childWorkspace = path.join(hub, member.path, ".mate", "plugins");
    await fs.mkdir(childWorkspace, { recursive: true });
    await fs.writeFile(path.join(childWorkspace, "child-marker"), "unchanged\n", "utf8");

    const store = new ConfigStore(path.join(hub, ".mate", "config", "framework.yaml"));
    const config = await store.load();
    config.plugins = [{ package: "@acme/hub-plugin", version: "latest" }];
    await store.save(config);

    const hydrated: string[] = [];
    const updated = await updateHubPlugins(hub, {
      installDeps: {
        runNpmInstall: async (workspaceRoot) => {
          const packageRoot = path.join(workspaceRoot, "node_modules", "@acme", "hub-plugin");
          await fs.mkdir(packageRoot, { recursive: true });
          await fs.writeFile(
            path.join(packageRoot, "package.json"),
            JSON.stringify({ name: "@acme/hub-plugin", version: "1.2.3" }),
            "utf8",
          );
          return { ok: true };
        },
        runNpmUpdate: async () => ({ ok: true }),
      },
      hydrate: async ({ companionPath }) => hydrated.push(companionPath),
    });

    expect(updated).toEqual([
      { package: "@acme/hub-plugin", status: "installed", resolvedVersion: "1.2.3" },
    ]);
    expect(hydrated).toEqual([hub]);
    expect(await fs.readFile(path.join(childWorkspace, "child-marker"), "utf8")).toBe(
      "unchanged\n",
    );
  });
});
