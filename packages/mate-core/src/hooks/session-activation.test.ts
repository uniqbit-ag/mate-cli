import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GlobalConfigStore } from "../lib/orchestrator/global-config-store";
import {
  RepoLocalRegistryStore,
  repoLocalRegistryPath,
  selectRepoLocalCompanion,
} from "../lib/orchestrator/repo-local-registry";
import { buildActivation, probeWorkingRepoFreshness } from "./session-activation";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  repoPath: string;
  companionPath: string;
  globalConfigStore: GlobalConfigStore;
}

async function makeFixture(prefix: string, options: { trusted?: boolean } = {}): Promise<Fixture> {
  const root = await makeTempDir(prefix);
  const repoPath = path.join(root, "repo");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    "type: companion\nallowedAgents:\n  - claude\ncapabilities:\n  - name: openspec\n",
    "utf8",
  );
  await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
    repository: { id: "acme", path: repoPath },
    companions: [{ path: companionPath, repositoryId: "acme" }],
  });

  const globalConfigStore = new GlobalConfigStore(path.join(root, "global-config.yaml"));
  if (options.trusted !== false) await globalConfigStore.register(companionPath);

  return { root, repoPath, companionPath, globalConfigStore };
}

function parseStdout(stdout: string): {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
} {
  return JSON.parse(stdout);
}

describe("buildActivation", () => {
  test("non-Mate directory is a silent no-op", async () => {
    const dir = await makeTempDir("activation-non-mate-");
    const outcome = await buildActivation(
      dir,
      {},
      {
        globalConfigStore: new GlobalConfigStore(path.join(dir, "config.yaml")),
      },
    );
    expect(outcome).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("untrusted pointer warns without injecting context", async () => {
    const fixture = await makeFixture("activation-untrusted-", { trusted: false });
    const outcome = await buildActivation(
      fixture.repoPath,
      {},
      {
        globalConfigStore: fixture.globalConfigStore,
      },
    );

    const payload = parseStdout(outcome.stdout);
    expect(payload.systemMessage).toContain("untrusted");
    expect(payload.systemMessage).toContain(path.resolve(fixture.companionPath));
    expect(payload.hookSpecificOutput).toBeUndefined();
  });

  test("trusted pointer injects the companion policy and banner", async () => {
    const fixture = await makeFixture("activation-trusted-");
    const outcome = await buildActivation(
      fixture.repoPath,
      {},
      {
        globalConfigStore: fixture.globalConfigStore,
      },
    );

    const payload = parseStdout(outcome.stdout);
    expect(payload.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    const context = payload.hookSpecificOutput!.additionalContext;
    expect(context).toContain("<companion-policy");
    expect(context).toContain(path.resolve(fixture.companionPath));
    expect(context).toContain(fixture.repoPath);
    // openspec capability gates the archive-finish rule into the policy.
    expect(context).toContain("openspec-finish");
    expect(payload.systemMessage).toContain(path.resolve(fixture.companionPath));
  });

  test("stale materialization injects the mate sync nudge with the restart note", async () => {
    const fixture = await makeFixture("activation-stale-");
    const outcome = await buildActivation(
      fixture.repoPath,
      {},
      {
        globalConfigStore: fixture.globalConfigStore,
      },
    );

    const context = parseStdout(outcome.stdout).hookSpecificOutput!.additionalContext;
    expect(context).toContain("mate sync");
    expect(context).toContain("next session");
  });

  test("ambiguous companions instruct the agent to ask and pin via companion select", async () => {
    const fixture = await makeFixture("activation-ambiguous-");
    const secondCompanion = path.join(fixture.root, "companion-b");
    await fs.mkdir(secondCompanion, { recursive: true });
    await fixture.globalConfigStore.register(secondCompanion);
    await new RepoLocalRegistryStore(repoLocalRegistryPath(fixture.repoPath)).save({
      repository: { id: "acme", path: fixture.repoPath },
      companions: [
        { path: fixture.companionPath, repositoryId: "acme" },
        { path: secondCompanion, repositoryId: "acme" },
      ],
    });

    const outcome = await buildActivation(
      fixture.repoPath,
      {},
      {
        globalConfigStore: fixture.globalConfigStore,
      },
    );

    const payload = parseStdout(outcome.stdout);
    const context = payload.hookSpecificOutput!.additionalContext;
    expect(context).toContain("AskUserQuestion");
    expect(context).toContain("companion select");
    expect(context).toContain("restart");
    expect(context).toContain(path.basename(fixture.companionPath));
    expect(context).toContain(path.basename(secondCompanion));
    expect(context).not.toContain("<companion-policy");

    const banner = payload.systemMessage!;
    expect(banner).toContain("none is pinned");
    expect(banner).toContain("companion select");
    expect(banner).toContain(path.basename(secondCompanion));
  });

  test("a pinned selection persists across sessions and activates without asking", async () => {
    const fixture = await makeFixture("activation-pinned-");
    const secondCompanion = path.join(fixture.root, "companion-b");
    await fs.mkdir(path.join(secondCompanion, ".mate", "config"), { recursive: true });
    await fs.writeFile(
      path.join(secondCompanion, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents:\n  - claude\n",
      "utf8",
    );
    await fixture.globalConfigStore.register(secondCompanion);
    await new RepoLocalRegistryStore(repoLocalRegistryPath(fixture.repoPath)).save({
      repository: { id: "acme", path: fixture.repoPath },
      companions: [
        { path: fixture.companionPath, repositoryId: "acme" },
        { path: secondCompanion, repositoryId: "acme" },
      ],
    });

    const pinned = await selectRepoLocalCompanion(fixture.repoPath, "companion-b");
    expect(pinned?.path).toBe(path.resolve(secondCompanion));

    for (let session = 0; session < 2; session += 1) {
      const outcome = await buildActivation(
        fixture.repoPath,
        {},
        {
          globalConfigStore: fixture.globalConfigStore,
        },
      );
      const context = parseStdout(outcome.stdout).hookSpecificOutput!.additionalContext;
      expect(context).toContain("<companion-policy");
      expect(context).toContain(path.resolve(secondCompanion));
      expect(context).not.toContain("Ask the user");
    }
  });
});

describe("probeWorkingRepoFreshness", () => {
  test("fresh after full materialization, stale after companion config change", async () => {
    const fixture = await makeFixture("activation-probe-");
    const settingsPath = path.join(fixture.repoPath, ".claude", "settings.local.json");

    expect(probeWorkingRepoFreshness(fixture.repoPath, fixture.companionPath)).toContain("missing");

    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ env: { MATE_ARTIFACT_PATH: path.resolve(fixture.companionPath) } }),
      "utf8",
    );
    await fs.mkdir(path.join(fixture.companionPath, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.companionPath, ".claude-plugin", "marketplace.json"),
      "{}",
      "utf8",
    );

    expect(probeWorkingRepoFreshness(fixture.repoPath, fixture.companionPath)).toBeNull();

    // Companion config edited after the last sync → stale.
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(
      path.join(fixture.companionPath, ".mate", "config", "framework.yaml"),
      future,
      future,
    );
    expect(probeWorkingRepoFreshness(fixture.repoPath, fixture.companionPath)).toContain("changed");
  });
});
