import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  launchAmbiguityDeps,
  launchShimDeps,
  makeLaunchCommand,
} from "./cli/commands/launch/shared";
import { runSyncCommand, type SyncCommandDeps } from "./cli/commands/sync";
import { buildActivation } from "./hooks/session-activation";
import { GlobalConfigStore } from "./lib/orchestrator/global-config-store";
import {
  RepoLocalRegistryStore,
  repoLocalRegistryPath,
} from "./lib/orchestrator/repo-local-registry";
import { resolveOpenCodeActivation } from "./opencode/activation";

// End-to-end composition of plugin-activated sessions: `mate sync`
// materializes everything a plain agent start needs, the SessionStart
// activation consumes exactly those files, and the deprecated shim adds
// nothing on top.

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
  repoPath: string;
  companionPath: string;
  globalConfigStore: GlobalConfigStore;
  syncDeps: SyncCommandDeps;
}

async function makeLinkedFixture(prefix: string): Promise<Fixture> {
  const root = await makeTempDir(prefix);
  const repoPath = path.join(root, "repo");
  const companionPath = path.join(root, "companion");

  await fs.mkdir(path.join(repoPath, ".git", "info"), { recursive: true });
  await fs.mkdir(path.join(repoPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, ".mate", "config", "framework.yaml"),
    "type: working\n",
    "utf8",
  );
  await new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath)).save({
    repository: { id: "acme", path: repoPath },
    companions: [{ path: companionPath, repositoryId: "acme" }],
  });

  await fs.mkdir(path.join(companionPath, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    [
      "type: companion",
      "allowedAgents:",
      "  - claude",
      "  - opencode",
      "capabilities:",
      "  - name: openspec",
      "",
    ].join("\n"),
    "utf8",
  );
  // Authored companion content the generated plugin must expose.
  const skillDir = path.join(companionPath, ".claude", "skills", "code-review");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\ndescription: review\n---\n", "utf8");
  await fs.writeFile(
    path.join(companionPath, ".mcp.json"),
    JSON.stringify({ mcpServers: { tokensave: { command: "tokensave", args: ["serve"] } } }),
    "utf8",
  );

  const globalConfigStore = new GlobalConfigStore(path.join(root, "global-config.yaml"));
  await globalConfigStore.register(companionPath);

  const syncDeps: SyncCommandDeps = {
    cwd: repoPath,
    globalConfigStore,
    syncCompanionFiles: async () => {},
    refreshCapabilityIndex: async () => {},
    validateClaudePluginAssets: () => {},
    collectOpenCodeRuntimeProblems: async () => [],
    registerMateClaudePluginGlobally: async () => {},
    registerMateOpenCodePluginGlobally: async () => {},
  };

  return { root, repoPath, companionPath, globalConfigStore, syncDeps };
}

describe("plugin-activated sessions E2E", () => {
  test("linked repo + plain start: sync materializes everything a launcher-free session loads", async () => {
    const fixture = await makeLinkedFixture("mate-e2e-plain-start-");

    await runSyncCommand([], fixture.syncDeps);
    expect(process.exitCode ?? 0).toBe(0);

    // Materialized settings carry the marketplace, plugin, env contract,
    // companion access, and MCP pre-approval — no launcher flags involved.
    const settings = JSON.parse(
      await fs.readFile(path.join(fixture.repoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.extraKnownMarketplaces["mate-companion"].source).toEqual({
      source: "directory",
      path: fixture.companionPath,
    });
    expect(settings.enabledPlugins["mate-companion@mate-companion"]).toBe(true);
    expect(settings.env.MATE_ARTIFACT_PATH).toBe(fixture.companionPath);
    expect(settings.env.MATE_REPO_PATH).toBe(fixture.repoPath);
    expect(settings.env.MATE_REPO_ID).toBe("acme");
    expect(settings.env.MATE_POLICY_JSON).toContain("claude");
    expect(settings.permissions.additionalDirectories).toContain(fixture.companionPath);
    expect(settings.enabledMcpjsonServers).toContain("tokensave");
    // Companion MCP tools reach the session through the single static gateway
    // entry in the working repo's .mcp.json, pre-approved via settings.
    expect(settings.enabledMcpjsonServers).toContain("mate");
    const workingRepoMcp = JSON.parse(
      await fs.readFile(path.join(fixture.repoPath, ".mcp.json"), "utf8"),
    );
    expect(workingRepoMcp.mcpServers.mate).toEqual({
      type: "stdio",
      command: "mate",
      args: ["mcp", "shim"],
    });

    // The generated companion plugin exposes the authored skills; MCP is
    // delivered via the gateway, never plugin-shipped.
    const plugin = JSON.parse(
      await fs.readFile(path.join(fixture.companionPath, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(plugin.skills).toEqual(["./.claude/skills/"]);
    expect(plugin.mcpServers).toBeUndefined();

    // SessionStart activation (what a GUI/plain start runs) injects the
    // policy for this exact state — and reports it fresh, no sync nudge.
    const activation = await buildActivation(fixture.repoPath, settings.env, {
      globalConfigStore: fixture.globalConfigStore,
    });
    const payload = JSON.parse(activation.stdout);
    const context = payload.hookSpecificOutput.additionalContext as string;
    expect(context).toContain("<companion-policy");
    expect(context).toContain(fixture.companionPath);
    expect(context).toContain("openspec-finish");
    expect(context).not.toContain("Run `mate sync`");

    // The OpenCode plugin activates from the same materialized state.
    const opencode = await resolveOpenCodeActivation(fixture.repoPath, {
      env: { HOME: "/nonexistent-home" },
    });
    // (Directory resolution needs the trust registry; the CLI store lives in
    // the fixture, so emulate the launch-env path a shim session provides.)
    expect(opencode.status).toBe("untrusted");
    const opencodeViaEnv = await resolveOpenCodeActivation(fixture.repoPath, {
      env: settings.env,
    });
    expect(opencodeViaEnv.status).toBe("active");
    if (opencodeViaEnv.status === "active") {
      expect(opencodeViaEnv.config.capabilities).toEqual([{ name: "openspec" }]);
    }
  });

  test("mate claude shim session equals a plain start: sync output is the only injection", async () => {
    const fixture = await makeLinkedFixture("mate-e2e-shim-parity-");

    // Plain-start state: what `mate sync` alone materializes.
    await runSyncCommand([], fixture.syncDeps);
    const settingsPath = path.join(fixture.repoPath, ".claude", "settings.local.json");
    const plainStartSettings = await fs.readFile(settingsPath, "utf8");

    // Shim run over the same repo.
    const originalRunSync = launchShimDeps.runSyncCommand;
    const originalSpawn = launchShimDeps.spawn;
    const originalResolve = launchAmbiguityDeps.resolveCompanionMatches;
    const originalCwd = process.cwd();
    const spawnMock = mock(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    try {
      launchAmbiguityDeps.resolveCompanionMatches = async () => [];
      launchShimDeps.runSyncCommand = (argv) => runSyncCommand(argv, fixture.syncDeps);
      launchShimDeps.spawn = spawnMock as never;
      process.chdir(fixture.repoPath);

      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        await makeLaunchCommand("claude")([], { directPassthrough: true });
      } finally {
        process.stderr.write = originalWrite;
      }
      expect(stderrChunks.join("")).toContain("deprecated");
    } finally {
      process.chdir(originalCwd);
      launchShimDeps.runSyncCommand = originalRunSync;
      launchShimDeps.spawn = originalSpawn;
      launchAmbiguityDeps.resolveCompanionMatches = originalResolve;
    }

    // Identical session inputs: same materialized settings bytes, bare spawn
    // with inherited env and zero Mate-injected flags.
    expect(await fs.readFile(settingsPath, "utf8")).toBe(plainStartSettings);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("claude");
    expect(args).toEqual([]);
    expect(options.env).toBe(process.env);
  });

  test("cloned repo with a crafted committed pointer stays inert everywhere", async () => {
    const root = await makeTempDir("mate-e2e-crafted-pointer-");
    const repoPath = path.join(root, "cloned-repo");
    const attackerPath = path.join(root, "attacker-companion");
    await fs.mkdir(attackerPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".mate", "config"), { recursive: true });
    // A hostile repo commits a pointer to an attacker-chosen path.
    await fs.writeFile(
      path.join(repoPath, ".mate", "config", "registry.yaml"),
      ["companions:", `  - path: ${attackerPath}`, "    repositoryId: acme", ""].join("\n"),
      "utf8",
    );
    const emptyGlobalStore = new GlobalConfigStore(path.join(root, "global-config.yaml"));

    // Claude SessionStart: warning, no context, no side effects.
    const activation = await buildActivation(repoPath, {}, { globalConfigStore: emptyGlobalStore });
    const payload = JSON.parse(activation.stdout);
    expect(payload.systemMessage).toContain("untrusted");
    expect(payload.hookSpecificOutput).toBeUndefined();

    // OpenCode plugin: untrusted, no hooks.
    const opencode = await resolveOpenCodeActivation(repoPath, {
      env: { HOME: path.join(root, "home") },
    });
    expect(opencode.status).toBe("untrusted");

    // `mate sync` refuses to materialize anything for the crafted pointer.
    await runSyncCommand([], { cwd: repoPath, globalConfigStore: emptyGlobalStore });
    expect(process.exitCode).toBe(1);
    await expect(
      fs.access(path.join(repoPath, ".claude", "settings.local.json")),
    ).rejects.toThrow();
  });
});
