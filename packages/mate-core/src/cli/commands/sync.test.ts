import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import {
  RepoLocalRegistryStore,
  repoLocalRegistryPath,
} from "../../lib/orchestrator/repo-local-registry";
import { runSyncCommand, type SyncCommandDeps } from "./sync";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  workingPath: string;
  companionPath: string;
  globalConfigStore: GlobalConfigStore;
}

async function makeLinkedFixture(
  prefix: string,
  companionConfigYaml = "type: companion\nallowedAgents:\n  - claude\n",
): Promise<Fixture> {
  const root = await makeTempDir(prefix);
  const workingPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");

  await fs.mkdir(path.join(workingPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(workingPath, ".mate", "config", "framework.yaml"),
    "type: working\n",
    "utf8",
  );
  await new RepoLocalRegistryStore(repoLocalRegistryPath(workingPath)).save({
    repository: { id: "app", path: workingPath },
    companions: [{ path: companionPath, repositoryId: "app" }],
  });

  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    companionConfigYaml,
    "utf8",
  );

  const globalConfigStore = new GlobalConfigStore(path.join(root, "global-config.yaml"));
  await globalConfigStore.register(companionPath);

  return { root, workingPath, companionPath, globalConfigStore };
}

function makeDeps(fixture: Fixture, overrides: Partial<SyncCommandDeps> = {}) {
  const calls = {
    git: mock(async () => ({}) as never),
    companionFiles: mock(async () => {}),
    index: mock(async () => {}),
  };
  const deps: SyncCommandDeps = {
    cwd: fixture.workingPath,
    globalConfigStore: fixture.globalConfigStore,
    syncCompanionGit: calls.git as never,
    syncCompanionFiles: calls.companionFiles,
    refreshCapabilityIndex: calls.index,
    validateClaudePluginAssets: () => {},
    collectOpenCodeRuntimeProblems: async () => [],
    registerMateClaudePluginGlobally: async () => {},
    registerMateOpenCodePluginGlobally: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<string[]> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return errors;
}

describe("runSyncCommand — working root", () => {
  test("pulls git (auto), materializes settings, generates the marketplace, refreshes the index", async () => {
    const fixture = await makeLinkedFixture(
      "mate-sync-working-",
      "type: companion\nallowedAgents:\n  - claude\ngit: auto\n",
    );
    const { deps, calls } = makeDeps(fixture);

    await runSyncCommand([], deps);

    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.git).toHaveBeenCalledWith(
      path.resolve(fixture.companionPath),
      fixture.workingPath,
    );
    expect(calls.companionFiles).toHaveBeenCalled();
    expect(calls.index).toHaveBeenCalled();

    const settings = JSON.parse(
      await fs.readFile(path.join(fixture.workingPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.env.MATE_ARTIFACT_PATH).toBe(path.resolve(fixture.companionPath));
    expect(settings.env.MATE_REPO_ID).toBe("app");

    const marketplace = JSON.parse(
      await fs.readFile(
        path.join(fixture.companionPath, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );
    expect(marketplace.name).toBe("mate-companion");
  });

  test("skips git without auto mode and with --no-git", async () => {
    const noAuto = await makeLinkedFixture("mate-sync-working-nogit-");
    {
      const { deps, calls } = makeDeps(noAuto);
      await runSyncCommand([], deps);
      expect(calls.git).not.toHaveBeenCalled();
    }

    const auto = await makeLinkedFixture(
      "mate-sync-working-nogit-flag-",
      "type: companion\nallowedAgents:\n  - claude\ngit: auto\n",
    );
    {
      const { deps, calls } = makeDeps(auto);
      await runSyncCommand(["--no-git"], deps);
      expect(calls.git).not.toHaveBeenCalled();
    }
  });

  test("fails with guidance when the repo is not linked", async () => {
    const root = await makeTempDir("mate-sync-unlinked-");
    const workingPath = path.join(root, "working");
    await fs.mkdir(path.join(workingPath, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(workingPath, ".mate", "config", "framework.yaml"),
      "type: working\n",
      "utf8",
    );

    const errors = await captureErrors(() =>
      runSyncCommand([], {
        cwd: workingPath,
        globalConfigStore: new GlobalConfigStore(path.join(root, "global-config.yaml")),
      }),
    );

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("companion link");
  });
});

describe("runSyncCommand — companion root", () => {
  test("refreshes runtime assets and regenerates the marketplace scaffold", async () => {
    const fixture = await makeLinkedFixture("mate-sync-companion-");
    const { deps, calls } = makeDeps(fixture, { cwd: fixture.companionPath });

    await runSyncCommand([], deps);

    expect(process.exitCode ?? 0).toBe(0);
    expect(calls.git).not.toHaveBeenCalled();
    expect(calls.companionFiles).toHaveBeenCalled();
    expect(calls.index).not.toHaveBeenCalled();
    const marketplace = JSON.parse(
      await fs.readFile(
        path.join(fixture.companionPath, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );
    expect(marketplace.name).toBe("mate-companion");
    // No working-repo settings written from a companion root.
    await expect(
      fs.access(path.join(fixture.workingPath, ".claude", "settings.local.json")),
    ).rejects.toThrow();
  });

  test("reports bundled-plugin repair problems and exits non-zero", async () => {
    const fixture = await makeLinkedFixture("mate-sync-companion-repair-");
    const { deps } = makeDeps(fixture, {
      cwd: fixture.companionPath,
      validateClaudePluginAssets: () => {
        throw new Error("bundled Claude plugin at /x is missing: plugin.json");
      },
    });

    const errors = await captureErrors(() => runSyncCommand([], deps));

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("plugin.json");
    expect(errors.join("\n")).toContain("reinstall");
  });
});

describe("runSyncCommand — hub root", () => {
  test("runs the companion sync for every member and reports per-member results", async () => {
    const root = await makeTempDir("mate-sync-hub-");
    const hubPath = path.join(root, "hub");
    const memberA = path.join(hubPath, "member-a");
    const memberB = path.join(hubPath, "member-b");
    for (const member of [memberA, memberB]) {
      await fs.mkdir(path.join(member, ".mate", "config"), { recursive: true });
      await fs.writeFile(
        path.join(member, ".mate", "config", "framework.yaml"),
        "type: companion\nallowedAgents:\n  - claude\n",
        "utf8",
      );
    }
    await fs.mkdir(path.join(hubPath, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(hubPath, ".mate", "config", "framework.yaml"),
      [
        "type: hub",
        "allowedAgents: []",
        "hub:",
        "  companions:",
        "    - id: member-a",
        "      path: member-a",
        "      source:",
        "        kind: local",
        "    - id: member-b",
        "      path: member-b",
        "      source:",
        "        kind: local",
        "",
      ].join("\n"),
      "utf8",
    );

    const companionFiles = mock(async () => {});
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await runSyncCommand([], {
        cwd: hubPath,
        globalConfigStore: new GlobalConfigStore(path.join(root, "global-config.yaml")),
        syncCompanionFiles: companionFiles,
        validateClaudePluginAssets: () => {},
        collectOpenCodeRuntimeProblems: async () => [],
        registerMateClaudePluginGlobally: async () => {},
        registerMateOpenCodePluginGlobally: async () => {},
      });
    } finally {
      console.log = originalLog;
    }

    expect(process.exitCode ?? 0).toBe(0);
    const syncedPaths = companionFiles.mock.calls.map((call) => call[0]);
    expect(syncedPaths.sort()).toEqual([memberA, memberB].sort());
    expect(logs.join("\n")).toContain("member-a");
    expect(logs.join("\n")).toContain("member-b");
  });
});

describe("runSyncCommand — check mode", () => {
  test("passes on fresh state without modifying files", async () => {
    const fixture = await makeLinkedFixture("mate-sync-check-fresh-");
    {
      const { deps } = makeDeps(fixture);
      await runSyncCommand([], deps);
    }
    const settingsPath = path.join(fixture.workingPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    const { deps } = makeDeps(fixture);
    await runSyncCommand(["--check"], deps);

    expect(process.exitCode ?? 0).toBe(0);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  });

  test("reports stale managed keys and exits non-zero without writing", async () => {
    const fixture = await makeLinkedFixture("mate-sync-check-stale-");
    {
      const { deps } = makeDeps(fixture);
      await runSyncCommand([], deps);
    }

    // Companion capability configuration changes after the last sync.
    await fs.writeFile(
      path.join(fixture.companionPath, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents:\n  - claude\ncapabilities:\n  - name: graphify\n",
      "utf8",
    );

    const settingsPath = path.join(fixture.workingPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    const { deps, calls } = makeDeps(fixture);
    const errors = await captureErrors(() => runSyncCommand(["--check"], deps));

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("env");
    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
    expect(calls.git).not.toHaveBeenCalled();
    expect(calls.companionFiles).not.toHaveBeenCalled();
  });
});

describe("runSyncCommand — no root", () => {
  test("fails when no Mate root resolves", async () => {
    const root = await makeTempDir("mate-sync-noroot-");
    const errors = await captureErrors(() =>
      runSyncCommand([], {
        cwd: root,
        globalConfigStore: new GlobalConfigStore(path.join(root, "global-config.yaml")),
      }),
    );

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("No Mate root");
  });
});
