import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { companionGitDeps } from "../../runtime/companion-git";
import { makeSshStub, stubHttpsUrl } from "../../../../../test/ssh-stub";
import {
  addHubMember,
  discoverGitSource,
  discoverHubSource,
  initializeCompanionHub,
  materializeHubMember,
  syncHub,
  updateHubPlugins,
} from "./companion-hub";
import { ConfigStore } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import type { FrameworkConfig } from "./types";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Every `initializeCompanionHub` call in this suite must pass this — its default constructs `~/.mate/config.yaml`, polluting the real developer registry with ephemeral test paths. */
function isolatedGlobalConfigStore(root: string): GlobalConfigStore {
  return new GlobalConfigStore(path.join(root, "global-config.yaml"));
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

const originalIsTerminal = companionGitDeps.isTerminal;

beforeEach(() => {
  companionGitDeps.isTerminal = () => false;
});

afterEach(async () => {
  companionGitDeps.isTerminal = originalIsTerminal;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("companion hub lifecycle", () => {
  test("initializes an existing folder without creating Git metadata", async () => {
    const root = await makeTempDir("hub-init-");
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n", "utf8");

    await initializeCompanionHub(root, isolatedGlobalConfigStore(root));

    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep\n");
    expect(
      await fs.readFile(path.join(root, ".mate", "config", "framework.yaml"), "utf8"),
    ).toContain("type: hub");
    const config = await new ConfigStore(
      path.join(root, ".mate", "config", "framework.yaml"),
    ).load();
    expect(config.allowedAgents).toEqual(["claude", "opencode"]);
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

    await expect(initializeCompanionHub(root, isolatedGlobalConfigStore(root))).rejects.toThrow(
      "linked working repository",
    );
    expect(
      await fs.stat(path.join(root, ".mate", "config", "framework.yaml")).catch(() => null),
    ).toBeNull();
  });

  test("copies a registered local-only companion without its source Git directory", async () => {
    const root = await makeTempDir("hub-local-");
    const source = await writeCompanion(root, "source");
    await fs.mkdir(path.join(source, ".git"));
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));

    const member = await addHubMember(hub, await discoverHubSource(source));

    expect(member.source.kind).toBe("local");
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("initial\n");
    expect(await fs.stat(path.join(hub, member.path, ".git")).catch(() => null)).toBeNull();
  });

  test("clones a Git-backed companion and records its commit", async () => {
    const root = await makeTempDir("hub-git-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));

    const member = await addHubMember(hub, await discoverGitSource(source));

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
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    /** No `insteadOf`: both the SSH attempt and the HTTPS fallback fail. */
    const env = { ...makeSshStub(root).env("refused"), GIT_CONFIG_COUNT: "0" };

    await expect(
      materializeHubMember(hub, { kind: "git", url: "https://example.test/acme.git" }, { env }),
    ).rejects.toThrow("Cloning https://example.test/acme.git failed");
    expect(await fs.stat(path.join(hub, "companions", "acme")).catch(() => null)).toBeNull();
  });

  test("clones over SSH first and falls back to the given HTTPS URL", async () => {
    const root = await makeTempDir("hub-ssh-clone-");
    const { remote } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const stub = makeSshStub(root);
    const url = stubHttpsUrl(remote);

    const member = await materializeHubMember(
      hub,
      { kind: "git", url },
      { env: stub.env("refused") },
    );

    expect(stub.calls()).toHaveLength(1);
    expect(stub.calls()[0]).toContain("git@example.test");
    expect(member.materializedCommit).toBeTruthy();
    expect(git(path.join(hub, member.path), "remote", "get-url", "origin")).toBe(url);
  });

  test("fast-forwards clean Git children and protects dirty children", async () => {
    const root = await makeTempDir("hub-sync-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const member = await addHubMember(hub, await discoverGitSource(source));

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

    const childHead = git(child, "rev-parse", "HEAD");
    const remoteHead = git(source, "rev-parse", "HEAD");
    const divergent = await syncHub(hub);
    expect(divergent[0]?.status).toBe("divergent");
    expect(git(child, "rev-parse", "HEAD")).toBe(childHead);
    expect(git(source, "ls-remote", "origin", "main").split(/\s+/)[0]).toBe(remoteHead);

    await fs.writeFile(path.join(hub, member.path, "notes.md"), "local\n", "utf8");
    const dirty = await syncHub(hub);
    expect(dirty[0]?.status).toBe("dirty");
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("local\n");
  });

  test("fast-forwards a child without a configured upstream to origin/HEAD", async () => {
    const root = await makeTempDir("hub-no-upstream-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const member = await addHubMember(hub, await discoverGitSource(source));
    const child = path.join(hub, member.path);
    git(child, "branch", "--unset-upstream");

    await fs.writeFile(path.join(source, "notes.md"), "updated\n", "utf8");
    git(source, "commit", "-am", "update");
    git(source, "push");

    const results = await syncHub(hub);

    expect(results[0]?.status).toBe("updated");
    expect(await fs.readFile(path.join(child, "notes.md"), "utf8")).toBe("updated\n");
  });

  test("reports a child with no resolvable synchronization target", async () => {
    const root = await makeTempDir("hub-no-target-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const member = await addHubMember(hub, await discoverGitSource(source));
    const child = path.join(hub, member.path);
    git(child, "branch", "--unset-upstream");
    git(child, "remote", "set-head", "origin", "--delete");
    git(child, "update-ref", "-d", "refs/remotes/origin/main");
    git(
      child,
      "config",
      "remote.origin.fetch",
      "+refs/heads/feature/*:refs/remotes/origin/feature/*",
    );
    const head = git(child, "rev-parse", "HEAD");

    const results = await syncHub(hub);

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.message).toBe("no synchronization target resolves");
    expect(git(child, "rev-parse", "HEAD")).toBe(head);
  });

  test("an exported GIT_DIR does not redirect hub sync", async () => {
    const root = await makeTempDir("hub-git-dir-");
    const { source } = await makeGitCompanion(root);
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const member = await addHubMember(hub, await discoverGitSource(source));
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    git(elsewhere, "init", "-q");

    await fs.writeFile(path.join(source, "notes.md"), "updated\n", "utf8");
    git(source, "commit", "-am", "update");
    git(source, "push");

    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, ".git");
    try {
      const results = await syncHub(hub);
      expect(results[0]?.status).toBe("updated");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    expect(await fs.readFile(path.join(hub, member.path, "notes.md"), "utf8")).toBe("updated\n");
  });

  test("reports local-only members without invoking Git", async () => {
    const root = await makeTempDir("hub-local-sync-");
    const source = await writeCompanion(root, "source");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    await addHubMember(hub, { kind: "local", path: source });
    const trace = path.join(root, "git-trace.log");

    const result = await syncHub(hub, { env: { ...process.env, GIT_TRACE: trace } });

    expect(result[0]?.status).toBe("local-only");
    expect(await fs.stat(trace).catch(() => null)).toBeNull();
  });

  test("updates declared hub plugins without touching child plugin workspaces", async () => {
    const root = await makeTempDir("hub-plugins-");
    const source = await writeCompanion(root, "source");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
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
      setup: async () => {},
    });

    expect(updated).toEqual([
      { package: "@acme/hub-plugin", status: "installed", resolvedVersion: "1.2.3" },
    ]);
    expect(hydrated).toEqual([hub]);
    expect(await fs.readFile(path.join(childWorkspace, "child-marker"), "utf8")).toBe(
      "unchanged\n",
    );
  });

  test("backfills provider agents for hubs persisted with an empty allowedAgents list", async () => {
    const root = await makeTempDir("hub-backfill-");
    const hub = path.join(root, "hub");
    await initializeCompanionHub(hub, isolatedGlobalConfigStore(root));
    const store = new ConfigStore(path.join(hub, ".mate", "config", "framework.yaml"));
    const legacy = await store.load();
    legacy.allowedAgents = [];
    await store.save(legacy);

    const setupConfigs: FrameworkConfig[] = [];
    await updateHubPlugins(hub, {
      setup: async (_companionPath, config) => {
        setupConfigs.push(config);
      },
    });

    expect((await store.load()).allowedAgents).toEqual(["claude", "opencode"]);
    expect(setupConfigs[0]?.allowedAgents).toEqual(["claude", "opencode"]);
  });
});
