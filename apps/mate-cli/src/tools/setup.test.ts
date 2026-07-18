import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { frameworkConfig } from "../framework";
import { ConfigStore } from "../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../lib/orchestrator/repo-local-registry";
import { TOKENSAVE_STORE_DIR, tokensaveDeps } from "./setup/capabilities/tokensave";
import {
  applySetupCompatibilities,
  createUvPluginForTest,
  executeSetup,
  syncCompanionFiles,
  syncWorkingRepoClaudeSettings,
  updateProjectGitignore,
} from "./setup";
import type { SetupContext } from "./setup/plugin";

const tempRoots: string[] = [];
const originalPath = process.env.PATH;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeExecutable(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function installOpenSpecStub(root: string): Promise<void> {
  const binDir = path.join(root, "bin");
  const stubPath = path.join(binDir, "openspec");
  const source = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    "const skills = ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'];",
    "const runtimeDirs = { claude: '.claude', opencode: '.opencode' };",
    "const command = args[0];",
    "const targetPath = args[args.length - 1];",
    "if (command === 'init') {",
    "  const toolsArg = args[args.indexOf('--tools') + 1] ?? '';",
    "  for (const tool of toolsArg.split(',').filter(Boolean)) {",
    "    const runtimeDir = runtimeDirs[tool];",
    "    if (!runtimeDir) continue;",
    "    for (const skill of skills) {",
    "      const skillDir = path.join(targetPath, runtimeDir, 'skills', skill);",
    "      fs.mkdirSync(skillDir, { recursive: true });",
    "      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${tool}:${skill}\\n`);",
    "    }",
    "  }",
    "  process.exit(0);",
    "}",
    "if (command === 'update') { process.exit(0); }",
    "process.exit(1);",
    "",
  ].join("\n");

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("executeSetup", () => {
  test("refuses linked working repositories before creating local config", async () => {
    const root = await makeTempDir("mate-setup-refusal-");
    const companionPath = path.join(root, "companion");
    const repositoryPath = path.join(root, "working");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );

    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repositoryPath, { recursive: true });

    await writeRepoLocalRegistryEntry(
      repositoryPath,
      companionPath,
      { id: "app", path: repositoryPath, profile: "default" },
      "git",
    );
    await globalConfigStore.register(companionPath);

    await expect(executeSetup({}, { cwd: repositoryPath, globalConfigStore })).rejects.toThrow(
      /linked working repo `app`/,
    );

    await expect(
      fs.readFile(
        path.join(repositoryPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
        "utf8",
      ),
    ).resolves.toContain("type: working");
    await expect(fs.access(path.join(repositoryPath, ".claude"))).rejects.toThrow();
  });

  test("replaces saved providers and capabilities with the selected set", async () => {
    const root = await makeTempDir("mate-setup-replace-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    await executeSetup(
      {
        allowedAgents: ["claude", "opencode"],
        capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
      },
      { cwd: root, globalConfigStore },
    );

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
        git: "default",
      },
      { cwd: root, globalConfigStore },
    );

    const config = JSON.parse(
      JSON.stringify(
        await fs.readFile(
          path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml"),
          "utf8",
        ),
      ),
    );
    expect(config).toContain("allowedAgents:");
    expect(config).not.toContain("- opencode");
    expect(config).not.toContain("react-doctor");
  });

  test("installs the tokensave binary at setup without indexing linked repos", async () => {
    const companionRoot = await makeTempDir("mate-setup-tokensave-linked-companion-");
    const workingRepoRoot = await makeTempDir("mate-setup-tokensave-linked-working-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(companionRoot, "home", ".mate", "config.yaml"),
    );
    await writeRepoLocalRegistryEntry(
      workingRepoRoot,
      companionRoot,
      { id: "app", path: workingRepoRoot, profile: "default" },
      "git",
    );

    const originalRun = tokensaveDeps.run;
    const originalRunCommand = tokensaveDeps.runCommand;
    const originalIsCommandOnPath = tokensaveDeps.isCommandOnPath;
    const originalPathValue = tokensaveDeps.pathValue;
    const versionChecks: string[] = [];
    const installCalls: Array<{ command: string; args: string[] }> = [];

    const runMock = mock((args: string[]) => {
      if (args[0] === "--version") {
        versionChecks.push(args[0]);
        return { ok: versionChecks.length > 1, stderr: "", stdout: "" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });
    const runCommandMock = mock(async (command: string, args: string[]) => {
      installCalls.push({ command, args });
    });
    tokensaveDeps.run = runMock;
    tokensaveDeps.runCommand = runCommandMock;
    tokensaveDeps.isCommandOnPath = (command) => command === "brew";
    tokensaveDeps.pathValue = () => "/opt/homebrew/bin";

    try {
      await executeSetup(
        {
          allowedAgents: ["claude"],
          capabilities: [{ name: "tokensave" }],
        },
        { cwd: companionRoot, globalConfigStore },
      );

      // Setup installs the binary once, companion-scoped. It does NOT fan out to linked
      // repos or build any graph — indexing is deferred to `mate cap index`.
      expect(installCalls).toEqual([
        {
          command: "brew",
          args: ["install", "aovestdipaperino/tap/tokensave"],
        },
      ]);
      expect(runMock.mock.calls.map((call) => [call[0][0], call[1]])).toEqual([
        ["--version", companionRoot],
        ["--version", companionRoot],
      ]);
      await expect(fs.access(path.join(workingRepoRoot, TOKENSAVE_STORE_DIR))).rejects.toThrow();
    } finally {
      tokensaveDeps.run = originalRun;
      tokensaveDeps.runCommand = originalRunCommand;
      tokensaveDeps.isCommandOnPath = originalIsCommandOnPath;
      tokensaveDeps.pathValue = originalPathValue;
    }
  });

  test(
    "rerun setup removes deselected framework-managed artifacts",
    async () => {
      const root = await makeTempDir("mate-setup-teardown-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      await executeSetup(
        {
          allowedAgents: ["claude", "opencode"],
          capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await fs.access(path.join(root, ".claude", "hooks", "react-doctor.sh"));
      await expect(fs.access(path.join(root, ".mate", "bin", "openspec"))).rejects.toThrow();

      await executeSetup(
        {
          allowedAgents: ["claude"],
          capabilities: [{ name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await expect(fs.access(path.join(root, ".mate", "bin", "openspec"))).rejects.toThrow();
      await expect(fs.access(path.join(root, ".opencode", "bin", "openspec"))).rejects.toThrow();
      await expect(fs.access(path.join(root, ".claude", "bin", "openspec"))).rejects.toThrow();
      await expect(fs.access(path.join(root, ".opencode"))).rejects.toThrow();
    },
    { timeout: 20000 },
  );

  test(
    "setup deploys react-doctor skill to per-tool dirs, not .agents",
    async () => {
      const root = await makeTempDir("mate-setup-skill-dirs-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );

      await executeSetup(
        {
          allowedAgents: ["claude", "opencode"],
          capabilities: [{ name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await fs.access(path.join(root, ".claude", "skills", "react-doctor", "SKILL.md"));
      await fs.access(path.join(root, ".opencode", "skills", "react-doctor", "SKILL.md"));
      await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
    },
    { timeout: 30000 },
  );

  test("setup deploys openspec skills to per-tool dirs based on allowedAgents", async () => {
    const root = await makeTempDir("mate-setup-openspec-skill-dirs-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    await executeSetup(
      {
        allowedAgents: ["claude", "opencode"],
        capabilities: [{ name: "openspec" }],
      },
      { cwd: root, globalConfigStore },
    );

    for (const skill of [
      "openspec-explore",
      "openspec-propose",
      "openspec-apply-change",
      "openspec-archive-change",
    ]) {
      await fs.access(path.join(root, ".claude", "skills", skill, "SKILL.md"));
      await fs.access(path.join(root, ".opencode", "skills", skill, "SKILL.md"));
    }
    await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
  });

  test("openspec skills not deployed to agent dir when that agent is not in allowedAgents", async () => {
    const root = await makeTempDir("mate-setup-openspec-skip-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
        git: "default",
      },
      { cwd: root, globalConfigStore },
    );

    await fs.access(path.join(root, ".claude", "skills", "openspec-explore", "SKILL.md"));
    await expect(
      fs.access(path.join(root, ".opencode", "skills", "openspec-explore")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(root, ".opencode", "skills", "openspec-explore")),
    ).rejects.toThrow();
  });

  test(
    "rerun setup removes openspec skills from all tool dirs when capability removed",
    async () => {
      const root = await makeTempDir("mate-setup-openspec-teardown-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      await executeSetup(
        {
          allowedAgents: ["claude", "opencode"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );

      await executeSetup(
        { allowedAgents: ["claude", "opencode"], capabilities: [] },
        { cwd: root, globalConfigStore },
      );

      for (const skill of [
        "openspec-explore",
        "openspec-propose",
        "openspec-apply-change",
        "openspec-archive-change",
      ]) {
        await expect(fs.access(path.join(root, ".claude", "skills", skill))).rejects.toThrow();
        await expect(fs.access(path.join(root, ".opencode", "skills", skill))).rejects.toThrow();
      }
    },
    { timeout: 10000 },
  );

  test(
    "rerun setup removes react-doctor skills and hook from all tool dirs when capability removed",
    async () => {
      const root = await makeTempDir("mate-setup-reactdoctor-teardown-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );

      await executeSetup(
        {
          allowedAgents: ["claude", "opencode"],
          capabilities: [{ name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await executeSetup(
        { allowedAgents: ["claude", "opencode"], capabilities: [] },
        { cwd: root, globalConfigStore },
      );

      await expect(
        fs.access(path.join(root, ".claude", "skills", "react-doctor")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(root, ".opencode", "skills", "react-doctor")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(root, ".claude", "hooks", "react-doctor.sh")),
      ).rejects.toThrow();

      try {
        const settings = JSON.parse(
          await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
        ) as Record<string, unknown>;
        expect((settings.hooks as Record<string, unknown>)?.PostToolBatch).toBeUndefined();
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    },
    { timeout: 10000 },
  );

  test("empty skills directories are pruned after last capability is removed", async () => {
    const root = await makeTempDir("mate-setup-prune-skills-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
      },
      { cwd: root, globalConfigStore },
    );

    await executeSetup(
      { allowedAgents: ["claude"], capabilities: [] },
      { cwd: root, globalConfigStore },
    );

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
  });

  test(
    "setup with claude then without claude leaves no .claude directory",
    async () => {
      const root = await makeTempDir("mate-teardown-claude-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      await executeSetup(
        {
          allowedAgents: ["claude"],
          capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await fs.access(path.join(root, ".claude", "skills", "react-doctor", "SKILL.md"));
      await fs.access(path.join(root, ".claude", "skills", "openspec-explore", "SKILL.md"));

      await executeSetup(
        {
          allowedAgents: [],
          capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await expect(fs.access(path.join(root, ".claude"))).rejects.toThrow();
    },
    { timeout: 10000 },
  );

  test(
    "setup with opencode then without opencode leaves no .opencode directory",
    async () => {
      const root = await makeTempDir("mate-teardown-opencode-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await fs.access(path.join(root, ".opencode", "skills", "react-doctor", "SKILL.md"));
      await fs.access(path.join(root, ".opencode", "skills", "openspec-explore", "SKILL.md"));
      await fs.access(path.join(root, ".opencode", "opencode.json"));
      await fs.access(path.join(root, ".opencode", "plugins", "mate-add-dir.ts"));
      await fs.access(path.join(root, ".opencode", "plugins", "mate-companion.ts"));
      await fs.access(path.join(root, ".opencode", "plugins", "mate-companion-tui.tsx"));

      await executeSetup(
        {
          allowedAgents: [],
          capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        },
        { cwd: root, globalConfigStore },
      );

      await expect(fs.access(path.join(root, ".opencode"))).rejects.toThrow();
    },
    { timeout: 10000 },
  );

  test("setup migrates legacy .agents/skills/react-doctor on configure", async () => {
    const root = await makeTempDir("mate-setup-legacy-migrate-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );

    // Simulate legacy state: .agents/skills/react-doctor/ exists from a previous install.
    const legacySkillDir = path.join(root, ".agents", "skills", "react-doctor");
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(path.join(legacySkillDir, "SKILL.md"), "legacy", "utf8");

    await executeSetup(
      { allowedAgents: ["opencode"], capabilities: [{ name: "react-doctor" }] },
      { cwd: root, globalConfigStore },
    );

    await expect(fs.access(path.join(root, ".agents"))).rejects.toThrow();
    await fs.access(path.join(root, ".opencode", "skills", "react-doctor", "SKILL.md"));
  });

  test(
    "launch-time sync restores the OpenCode companion plugin without removing unrelated files",
    { timeout: 10000 },
    async () => {
      const root = await makeTempDir("mate-opencode-sync-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      const { config } = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );

      const pluginPath = path.join(root, ".opencode", "plugins", "mate-companion.ts");
      const addDirPluginPath = path.join(root, ".opencode", "plugins", "mate-add-dir.ts");
      const sessionBannerPluginPath = path.join(
        root,
        ".opencode",
        "plugins",
        "mate-companion-tui.tsx",
      );
      const legacySessionBannerPluginPath = path.join(
        root,
        ".opencode",
        "plugins",
        "mate-session-banner.tsx",
      );
      const configPath = path.join(root, ".opencode", "opencode.json");
      const packagePath = path.join(root, ".opencode", "package.json");
      const userFilePath = path.join(root, ".opencode", "user-notes.txt");
      const dependencyDir = path.join(root, ".opencode", "node_modules", "left-alone");

      await fs.rm(pluginPath);
      await fs.rm(addDirPluginPath);
      await fs.rm(sessionBannerPluginPath);
      await fs.writeFile(legacySessionBannerPluginPath, "legacy\n", "utf8");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            instructions: ["./custom.md"],
            compaction: { preserve_recent_tokens: 999 },
            tool_output: { max_lines: 10 },
            plugin: ["./plugins/custom.ts"],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await fs.writeFile(userFilePath, "keep me\n", "utf8");
      await fs.mkdir(dependencyDir, { recursive: true });

      await syncCompanionFiles(root, config);

      await expect(fs.access(pluginPath)).resolves.toBeNull();
      await expect(fs.access(addDirPluginPath)).resolves.toBeNull();
      await expect(fs.access(sessionBannerPluginPath)).resolves.toBeNull();
      await expect(fs.access(legacySessionBannerPluginPath)).rejects.toThrow();
      await expect(fs.readFile(configPath, "utf8")).resolves.not.toContain('"../AGENTS.md"');
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"./custom.md"');
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain(
        '"preserve_recent_tokens": 999',
      );
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"reserved": 8000');
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"max_lines": 10');
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"max_bytes": 8192');
      await expect(fs.readFile(configPath, "utf8")).resolves.toContain('"mate": ".."');
      await expect(fs.readFile(packagePath, "utf8")).resolves.toContain(
        '"@opentui/solid": "^0.3.4"',
      );
      await expect(fs.readFile(userFilePath, "utf8")).resolves.toBe("keep me\n");
      await expect(fs.access(dependencyDir)).resolves.toBeNull();
    },
  );

  test(
    "launch-time sync skips rewriting managed OpenCode runtime files when manifest matches",
    async () => {
      const root = await makeTempDir("mate-opencode-sync-manifest-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      const { config } = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );

      const pluginPath = path.join(root, ".opencode", "plugins", "mate-companion.ts");
      const before = await fs.stat(pluginPath);

      await new Promise((resolve) => setTimeout(resolve, 25));
      await syncCompanionFiles(root, config);

      const after = await fs.stat(pluginPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
    { timeout: 10000 },
  );

  test(
    "launch-time sync rewrites OpenCode companion plugin when graphify capability state changes",
    async () => {
      const root = await makeTempDir("mate-opencode-sync-graphify-toggle-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);
      await installGraphifyStub(root);

      let setupResult = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );

      const pluginPath = path.join(root, ".opencode", "plugins", "mate-companion.ts");
      const guidancePath = path.join(root, ".opencode", ".mate-guidance.json");
      expect(JSON.parse(await fs.readFile(guidancePath, "utf8")).codebaseExplorationGuidance).toBe(
        "",
      );

      setupResult = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }, { name: "graphify" }],
        },
        { cwd: root, globalConfigStore },
      );

      await syncCompanionFiles(root, setupResult.config);

      const guidance = JSON.parse(await fs.readFile(guidancePath, "utf8"));
      expect(guidance.companionGuidance).toContain(
        '<companion-policy framework="mate" priority="mandatory">',
      );
      expect(guidance.companionGuidance).toContain("$MATE_REPO_PATH");
      expect(guidance.companionGuidance).toContain("$MATE_ARTIFACT_PATH");
      expect(guidance.companionGuidance).toContain("$MATE_WRAPPER_BIN_PATH");
      expect(guidance.companionGuidance).toContain('invokeAs="$MATE_WRAPPER_BIN_PATH/openspec"');
      expect(guidance.companionGuidance).toContain('invokeAs="$MATE_WRAPPER_BIN_PATH/graphify"');
      expect(guidance.codebaseExplorationGuidance).toContain(
        '<codebase-exploration-rules priority="mandatory">',
      );
      expect(guidance.codebaseExplorationGuidance).toContain(
        "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/",
      );
      expect(guidance.codebaseExplorationGuidance).toContain("graphify -> grep/glob/read");
      expect(guidance.codebaseExplorationGuidance).toContain("MUST try graphify before raw source");
      expect(await fs.readFile(guidancePath, "utf8")).not.toContain("__MATE_");
    },
    { timeout: 10000 },
  );

  test(
    "launch-time sync injects tokensave-only exploration guidance when graphify is disabled",
    async () => {
      const root = await makeTempDir("mate-opencode-sync-tokensave-only-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      let setupResult = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }, { name: "tokensave" }],
        },
        { cwd: root, globalConfigStore },
      );

      await syncCompanionFiles(root, setupResult.config);

      const guidancePath = path.join(root, ".opencode", ".mate-guidance.json");
      const guidance = JSON.parse(await fs.readFile(guidancePath, "utf8"));
      expect(guidance.companionGuidance).toContain(
        '<companion-policy framework="mate" priority="mandatory">',
      );
      expect(guidance.codebaseExplorationGuidance).toContain(
        '<codebase-exploration-rules priority="mandatory">',
      );
      expect(guidance.codebaseExplorationGuidance).toContain("tokensave_context");
      expect(guidance.codebaseExplorationGuidance).toContain("tokensave -> grep/glob/read");
      expect(guidance.codebaseExplorationGuidance).toContain(
        "MUST try tokensave before raw source",
      );
      expect(guidance.codebaseExplorationGuidance).not.toContain(
        "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/",
      );
      expect(await fs.readFile(guidancePath, "utf8")).not.toContain("__MATE_");
    },
    { timeout: 10000 },
  );

  test(
    "launch-time sync rewrites managed OpenCode runtime files when manifest detects drift",
    async () => {
      const root = await makeTempDir("mate-opencode-sync-drift-");
      const globalConfigStore = new GlobalConfigStore(
        path.join(root, "home", ".mate", "config.yaml"),
      );
      await installOpenSpecStub(root);

      const { config } = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );

      const pluginPath = path.join(root, ".opencode", "plugins", "mate-companion.ts");
      await fs.writeFile(pluginPath, "// drifted\n", "utf8");

      await syncCompanionFiles(root, config);

      await expect(fs.readFile(pluginPath, "utf8")).resolves.not.toContain("drifted");
    },
    { timeout: 10000 },
  );

  test("launch-time sync migrates claude guidance from .claude/CLAUDE.md to root CLAUDE.md", async () => {
    const root = await makeTempDir("mate-claude-sync-guidance-migration-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude", "CLAUDE.md"),
      [
        "<!-- MATE:COMPANION:GUIDANCE:START -->",
        "legacy guidance",
        "<!-- MATE:COMPANION:GUIDANCE:END -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await syncCompanionFiles(root, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
    });

    const rootClaudeMd = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(rootClaudeMd).toContain("<!-- MATE:COMPANION:START -->");
    expect(rootClaudeMd).not.toContain("legacy guidance");
    await expect(fs.access(path.join(root, ".claude", "CLAUDE.md"))).rejects.toThrow();
  });

  test("setup persists selected package managers", async () => {
    const root = await makeTempDir("mate-setup-package-managers-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    const { config } = await executeSetup(
      {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [{ name: "openspec" }],
      },
      { cwd: root, globalConfigStore },
    );

    expect(config.packageManagers).toEqual(["bun", "uv"]);
  });

  test("setup persists openspec schema profile and writes companion-local openspec config", async () => {
    const root = await makeTempDir("mate-setup-openspec-schema-profile-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    const { config } = await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
      },
      { cwd: root, globalConfigStore },
    );

    expect(config.capabilities).toContainEqual({
      name: "openspec",
      schemaProfile: "mate-v1",
    });
    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).resolves.toBe(
      "schema: mate-v1\n",
    );
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml")),
    ).resolves.toBeNull();

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
      },
      { cwd: root, globalConfigStore },
    );

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).rejects.toThrow();
  });

  test("setup persists git auto mode selection", async () => {
    const root = await makeTempDir("mate-setup-git-mode-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);

    const { config } = await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
        git: "auto",
      },
      { cwd: root, globalConfigStore },
    );

    expect(config.git).toBe("auto");

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
        git: "default",
      },
      { cwd: root, globalConfigStore },
    );

    const persisted = await new ConfigStore(
      path.join(root, ".mate", "config", "framework.yaml"),
    ).load();
    expect(persisted.capabilities).toContainEqual({ name: "openspec" });
    expect(persisted.git).toBeUndefined();
  });

  test("setup writes uv ignore block into the project .gitignore when uv is enabled", async () => {
    const root = await makeTempDir("mate-setup-uv-gitignore-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );
    await installOpenSpecStub(root);
    const binDir = path.join(root, "bin");
    const uvPath = path.join(binDir, "uv");
    const originalPath = process.env.PATH;
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      uvPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "init" ]; then',
        "  touch pyproject.toml",
        "  touch uv.lock",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(uvPath, 0o755);
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      await executeSetup(
        {
          allowedAgents: ["claude"],
          packageManagers: ["bun", "uv"],
          capabilities: [{ name: "openspec" }],
        },
        { cwd: root, globalConfigStore },
      );
    } finally {
      process.env.PATH = originalPath;
    }

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(`# ${frameworkConfig.name} managed: start`);
    expect(gitignore).toContain(".venv/");
    expect(gitignore).toContain(".uv/");
    expect(gitignore).toContain("__pycache__/");
    expect(gitignore).toContain("*.py[cod]");
    expect(gitignore).toContain("*.egg-info/");
    expect(gitignore).toContain("build/");
    expect(gitignore).toContain("dist/");
  });

  test("setup writes headroom capability to config when headroom binary is present", async () => {
    const root = await makeTempDir("mate-setup-headroom-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(root, "home", ".mate", "config.yaml"),
    );

    // Put a headroom stub on PATH so apply() skips the install prompt
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "headroom"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(path.join(binDir, "headroom"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "headroom" }],
      },
      { cwd: root, globalConfigStore },
    );

    const config = await fs.readFile(
      path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: headroom");
    expect(config).not.toContain("memory: true");

    // teardown is a no-op: re-running setup without headroom just removes it from config
    await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [],
      },
      { cwd: root, globalConfigStore },
    );

    const updatedConfig = await fs.readFile(
      path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "utf8",
    );
    expect(updatedConfig).not.toContain("name: headroom");
  });
});

describe("uv plugin (createUvPluginForTest)", () => {
  function makeCtx(companionPath: string): SetupContext {
    return {
      companionPath,
      config: { profiles: { default: { name: "default", allowedAgents: [] } } },
      mode: "setup",
      activeProviders: [],
    };
  }

  test("uv apply skips install when uv is already on PATH", async () => {
    const runCommandMock = mock(async () => {});
    const runShellCommandMock = mock(async () => {});
    const uvPlugin = createUvPluginForTest({
      isCommandOnPath: (command) => command === "uv",
      runCommand: runCommandMock,
      runShellCommand: runShellCommandMock,
    });

    await uvPlugin.apply(makeCtx("/tmp/companion"));

    expect(runShellCommandMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  test("uv apply installs via brew on macOS when brew is present", async () => {
    const runCommandMock = mock(async () => {});
    const uvPlugin = createUvPluginForTest({
      platform: "darwin",
      isCommandOnPath: (command) => command === "brew",
      runCommand: runCommandMock,
      runShellCommand: mock(async () => {}),
    });

    await uvPlugin.apply(makeCtx("/tmp/companion"));

    expect(runCommandMock).toHaveBeenCalledWith("brew", ["install", "uv"]);
    expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
  });

  test("uv apply installs via curl on macOS when brew is absent", async () => {
    const runCommandMock = mock(async () => {});
    const runShellCommandMock = mock(async () => {});
    const uvPlugin = createUvPluginForTest({
      platform: "darwin",
      isCommandOnPath: () => false,
      runCommand: runCommandMock,
      runShellCommand: runShellCommandMock,
    });

    await uvPlugin.apply(makeCtx("/tmp/companion"));

    expect(runShellCommandMock).toHaveBeenCalledWith(
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
    );
    expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
  });

  test("uv apply installs via curl on Linux when uv is absent", async () => {
    const runCommandMock = mock(async () => {});
    const runShellCommandMock = mock(async () => {});
    const uvPlugin = createUvPluginForTest({
      platform: "linux",
      isCommandOnPath: () => false,
      runCommand: runCommandMock,
      runShellCommand: runShellCommandMock,
    });

    await uvPlugin.apply(makeCtx("/tmp/companion"));

    expect(runShellCommandMock).toHaveBeenCalledWith(
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
    );
    expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
  });

  test("uv apply installs via PowerShell on Windows when uv is absent", async () => {
    const runCommandMock = mock(async () => {});
    const uvPlugin = createUvPluginForTest({
      platform: "win32",
      isCommandOnPath: () => false,
      runCommand: runCommandMock,
      runShellCommand: mock(async () => {}),
    });

    await uvPlugin.apply(makeCtx("/tmp/companion"));

    expect(runCommandMock).toHaveBeenCalledWith("powershell", [
      "-ExecutionPolicy",
      "ByPass",
      "-c",
      "irm https://astral.sh/uv/install.ps1 | iex",
    ]);
    expect(runCommandMock).toHaveBeenCalledWith("uv", ["tool", "update-shell"]);
  });

  test("uv apply rejects unsupported platforms when uv is absent", async () => {
    const uvPlugin = createUvPluginForTest({
      platform: "aix",
      isCommandOnPath: () => false,
      runCommand: mock(async () => {}),
      runShellCommand: mock(async () => {}),
    });

    await expect(uvPlugin.apply(makeCtx("/tmp/companion"))).rejects.toThrow(
      "Unsupported platform for uv setup: aix",
    );
  });

  test("uv teardown is a no-op", async () => {
    const uvPlugin = createUvPluginForTest({});
    await expect(uvPlugin.teardown(makeCtx("/tmp/companion"))).resolves.toBeUndefined();
  });
});

async function installGraphifyStub(root: string): Promise<void> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "graphify"), "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(path.join(binDir, "graphify"), 0o755);
}

describe("applySetupCompatibilities — graphify", () => {
  test("graphify capability does not write graphify guidance to CLAUDE.md or AGENTS.md", async () => {
    const root = await makeTempDir("mate-setup-graphify-guidance-");
    await installOpenSpecStub(root);
    await installGraphifyStub(root);

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude", "opencode"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "setup",
    );

    const claudeContent = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    const agentsContent = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(claudeContent).not.toContain("## graphify");
    expect(agentsContent).not.toContain("## graphify");
  });

  test("graphify capability does not create companion-owned wrappers", async () => {
    const root = await makeTempDir("mate-setup-graphify-enabled-");
    await installOpenSpecStub(root);
    await installGraphifyStub(root);

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude", "opencode"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "setup",
    );

    await expect(fs.access(path.join(root, ".mate", "bin", "graphify"))).rejects.toThrow();
  });

  test("graphify capability removes wrappers when capability is disabled", async () => {
    const root = await makeTempDir("mate-setup-graphify-disabled-");
    await installOpenSpecStub(root);
    await installGraphifyStub(root);

    // Enable graphify first
    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "setup",
    );
    // Now disable graphify
    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [],
      },
      "setup",
    );
    await expect(fs.access(path.join(root, ".mate", "bin", "graphify"))).rejects.toThrow();
  });

  test("graphify capability leaves wrapper packaging unchanged during launch-time sync", async () => {
    const root = await makeTempDir("mate-setup-graphify-sync-");
    await installOpenSpecStub(root);
    await installGraphifyStub(root);

    // Initial setup
    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "setup",
    );

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "sync",
    );
    await expect(fs.access(path.join(root, ".mate", "bin", "graphify"))).rejects.toThrow();
  });

  test("graphify capability adds graphify cache entries to .gitignore", async () => {
    const root = await makeTempDir("mate-setup-graphify-gitignore-");
    await installOpenSpecStub(root);
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: [] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
      "setup",
    );

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".graphify/*/graphify-out/cache/");
    expect(gitignore).toContain(".graphify/*/graphify-out/graph.html");
    expect(gitignore).toContain(".graphify/*/graphify-out/.graphify_root");
    expect(gitignore).toContain(".graphify/*/graphify-out/.graphify_python");
    expect(gitignore).toContain(".graphify/*/graphify-out/obsidian/");
    expect(gitignore).toContain(".graphify/*/graphify-out/cost.json");
    expect(gitignore).toContain(".graphify/*/graphify-out/.graphify_labels.json");
    expect(gitignore).toContain(".graphify/*/graphify-out/manifest.json");
    expect(gitignore).toContain(".obsidian/");
  });

  test("graphify gitignore entries remain managed even when graphify is disabled", async () => {
    const root = await makeTempDir("mate-setup-graphify-gitignore-persist-");
    await installOpenSpecStub(root);
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: [] } },
        packageManagers: ["bun"],
        capabilities: [],
      },
      "setup",
    );

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".graphify/*/graphify-out/cache/");
  });
});

describe("applySetupCompatibilities — openspec", () => {
  test("setup reports manual OpenSpec install when openspec and npm are missing", async () => {
    const root = await makeTempDir("mate-setup-openspec-missing-setup-");
    const emptyBin = path.join(root, "empty-bin");
    await fs.mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await applySetupCompatibilities(
        root,
        {
          profiles: { default: { name: "default", allowedAgents: ["claude"] } },
          packageManagers: ["bun"],
          capabilities: [{ name: "openspec" }],
        },
        "setup",
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toContain("npm install -g @fission-ai/openspec@latest");
    await expect(
      fs.access(path.join(root, ".claude", "skills", "openspec-explore")),
    ).rejects.toThrow();
  });

  test("launch-time sync skips OpenSpec reconciliation when openspec is missing", async () => {
    const root = await makeTempDir("mate-setup-openspec-missing-sync-");
    const emptyBin = path.join(root, "empty-bin");
    await fs.mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await applySetupCompatibilities(
        root,
        {
          profiles: { default: { name: "default", allowedAgents: ["claude"] } },
          packageManagers: ["bun"],
          capabilities: [{ name: "openspec" }],
        },
        "sync",
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toContain("npm install -g @fission-ai/openspec@latest");
    await expect(
      fs.access(path.join(root, ".claude", "skills", "openspec-explore")),
    ).rejects.toThrow();
  });
});

describe("applySetupCompatibilities — tokensave", () => {
  test("tokensave capability writes claude MCP wiring into companion settings", async () => {
    const root = await makeTempDir("mate-setup-tokensave-enabled-");
    await installOpenSpecStub(root);

    const originalRun = tokensaveDeps.run;
    tokensaveDeps.run = mock((args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: "tokensave 0.0.0" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });

    try {
      await applySetupCompatibilities(
        root,
        {
          profiles: { default: { name: "default", allowedAgents: ["claude"] } },
          packageManagers: ["bun"],
          capabilities: [{ name: "tokensave" }],
        },
        "setup",
      );

      const settings = JSON.parse(
        await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
      );
      // MCP server is written to the companion .mcp.json, not inline in
      // settings.local.json, though the mcp permission entry is still pre-seeded.
      expect(settings.mcpServers?.tokensave).toBeUndefined();
      expect(settings.permissions?.allow ?? []).toContain("mcp__tokensave__*");
      expect(settings.hooks?.PreToolUse).toContainEqual(
        expect.objectContaining({ matcher: "Agent|Grep|Bash" }),
      );
      expect(settings.hooks?.UserPromptSubmit).toBeDefined();
      expect(settings.hooks?.Stop).toBeDefined();

      const mcpConfig = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
      expect(mcpConfig.mcpServers?.tokensave?.args).toEqual(["serve"]);
    } finally {
      tokensaveDeps.run = originalRun;
    }
  });

  test("launch-time sync with opencode keeps repo-root tokensave files absent and writes companion MCP config", async () => {
    const companionRoot = await makeTempDir("mate-setup-tokensave-opencode-companion-");
    const workingRepoRoot = await makeTempDir("mate-setup-tokensave-opencode-working-");
    await installOpenSpecStub(companionRoot);
    const globalConfigStore = new GlobalConfigStore(
      path.join(companionRoot, "home", ".mate", "config.yaml"),
    );

    const originalRun = tokensaveDeps.run;
    tokensaveDeps.run = mock((args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: "tokensave 0.0.0" };
      }
      return { ok: true, stderr: "", stdout: "" };
    });

    try {
      const { config } = await executeSetup(
        {
          allowedAgents: ["opencode"],
          capabilities: [{ name: "tokensave" }],
        },
        { cwd: companionRoot, globalConfigStore },
      );

      await syncCompanionFiles(companionRoot, config, workingRepoRoot);

      const companionConfig = JSON.parse(
        await fs.readFile(path.join(companionRoot, ".opencode", "opencode.json"), "utf8"),
      );
      expect(companionConfig.mcp?.tokensave).toEqual({
        type: "local",
        command: ["tokensave", "serve"],
        enabled: true,
      });

      await expect(fs.access(path.join(workingRepoRoot, "AGENTS.md"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, "CLAUDE.md"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, "opencode.json"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, ".mcp.json"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, "opencode.json.bak"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, ".mcp.json.bak"))).rejects.toThrow();
    } finally {
      tokensaveDeps.run = originalRun;
    }
  });

  test("launch-time sync with claude installs tokensave wiring into companion settings", async () => {
    const companionRoot = await makeTempDir("mate-setup-tokensave-claude-companion-");
    const workingRepoRoot = await makeTempDir("mate-setup-tokensave-claude-working-");
    const binDir = await makeTempDir("mate-setup-tokensave-bin-");
    await installOpenSpecStub(companionRoot);
    const globalConfigStore = new GlobalConfigStore(
      path.join(companionRoot, "home", ".mate", "config.yaml"),
    );
    const originalPath = process.env.PATH;
    const tokensavePath = await makeExecutable(binDir, "tokensave");

    const originalRun = tokensaveDeps.run;
    tokensaveDeps.run = mock((args: string[], cwd: string) => {
      if (args[0] === "--version") {
        return { ok: true, stderr: "", stdout: "tokensave 0.0.0" };
      }

      return { ok: true, stderr: "", stdout: "" };
    });

    try {
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      const { config } = await executeSetup(
        {
          allowedAgents: ["claude"],
          capabilities: [{ name: "tokensave" }],
        },
        { cwd: companionRoot, globalConfigStore },
      );

      await syncCompanionFiles(companionRoot, config, workingRepoRoot);
      await syncWorkingRepoClaudeSettings(workingRepoRoot, companionRoot, config);

      const companionSettings = JSON.parse(
        await fs.readFile(path.join(companionRoot, ".claude", "settings.local.json"), "utf8"),
      );
      // MCP server lives in the companion .mcp.json (loaded via --mcp-config),
      // not inline in settings.local.json, though the mcp permission entry is
      // still pre-seeded.
      expect(companionSettings.mcpServers?.tokensave).toBeUndefined();
      expect(companionSettings.permissions?.allow ?? []).toContain("mcp__tokensave__*");

      const companionMcpConfig = JSON.parse(
        await fs.readFile(path.join(companionRoot, ".mcp.json"), "utf8"),
      );
      expect(companionMcpConfig.mcpServers?.tokensave).toEqual({
        command: tokensavePath,
        args: ["serve"],
      });
      expect(companionSettings.hooks?.PreToolUse).toContainEqual({
        matcher: "Agent|Grep|Bash",
        hooks: [
          {
            type: "command",
            command: tokensavePath,
            args: ["hook-pre-tool-use"],
          },
        ],
      });
      expect(companionSettings.hooks?.UserPromptSubmit).toContainEqual({
        hooks: [{ type: "command", command: tokensavePath, args: ["hook-prompt-submit"] }],
      });
      expect(companionSettings.hooks?.Stop).toContainEqual({
        hooks: [{ type: "command", command: tokensavePath, args: ["hook-stop"] }],
      });

      // The working repo receives only the Claude additional directory pointer.
      await expect(fs.access(path.join(workingRepoRoot, ".mcp.json"))).rejects.toThrow();
      await expect(fs.access(path.join(workingRepoRoot, "CLAUDE.md"))).rejects.toThrow();
      const workingRepoSettings = JSON.parse(
        await fs.readFile(path.join(workingRepoRoot, ".claude", "settings.local.json"), "utf8"),
      );
      expect(workingRepoSettings).toEqual({
        permissions: { additionalDirectories: [companionRoot] },
      });
    } finally {
      tokensaveDeps.run = originalRun;
      process.env.PATH = originalPath;
    }
  });
});

describe("applySetupCompatibilities", () => {
  test("headroom capability applies without uv since it no longer requires a package manager", async () => {
    const root = await makeTempDir("mate-setup-headroom-no-uv-");
    await installOpenSpecStub(root);

    // Put a headroom stub on PATH so apply() skips the install prompt
    const binDir = path.join(root, "bin");
    await fs.writeFile(path.join(binDir, "headroom"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(path.join(binDir, "headroom"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await applySetupCompatibilities(
        root,
        {
          profiles: { default: { name: "default", allowedAgents: [] } },
          packageManagers: ["bun"],
          capabilities: [{ name: "headroom" }],
        },
        "setup",
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).not.toContain("headroom capability disabled");
  });

  test("removes legacy settings.json and generates managed settings.local.json during setup", async () => {
    const root = await makeTempDir("mate-setup-claude-settings-migrate-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + "\n",
      "utf8",
    );

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
      },
      "setup",
    );

    // Unmanaged legacy settings.json is removed so it cannot shadow companion config.
    await expect(fs.access(path.join(root, ".claude", "settings.json"))).rejects.toThrow();

    // Mate-managed settings.local.json is generated with the validate hook.
    const settings = JSON.parse(
      await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: "Write|Edit|MultiEdit|Bash",
        hooks: [{ type: "command", command: `${root}/.claude/hooks/validate-artifact-path` }],
      },
    ]);
  });
});

describe("updateProjectGitignore", () => {
  test("writes a unified managed block for uv without removing user entries", async () => {
    const root = await makeTempDir("mate-sync-uv-gitignore-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ncustom.log\n", "utf8");

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun", "uv"],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("custom.log");
    expect(
      gitignore.match(new RegExp(`# ${frameworkConfig.name} managed: start`, "g"))?.length,
    ).toBe(1);
    expect(gitignore).toContain(".venv/");
  });

  test("adds companion-local Claude settings to the managed gitignore block when claude is enabled", async () => {
    const root = await makeTempDir("mate-sync-claude-settings-gitignore-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      packageManagers: ["bun"],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".claude/settings.local.json");
  });

  test("keeps sticky managed entries when no features are enabled", async () => {
    const root = await makeTempDir("mate-sync-uv-gitignore-remove-");
    await fs.writeFile(
      path.join(root, ".gitignore"),
      [
        "node_modules/",
        "",
        `# ${frameworkConfig.name} managed: start`,
        "# python / uv",
        ".venv/",
        ".uv/",
        "__pycache__/",
        "*.py[cod]",
        "*.egg-info/",
        "build/",
        "dist/",
        `# ${frameworkConfig.name} managed: end`,
        "",
      ].join("\n"),
      "utf8",
    );

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun"],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".graphify/*/graphify-out/cache/");
    expect(gitignore).not.toContain(".venv/");
  });

  test("migrates legacy per-feature blocks to the unified block", async () => {
    const root = await makeTempDir("mate-sync-legacy-gitignore-");
    await fs.writeFile(
      path.join(root, ".gitignore"),
      [
        "node_modules/",
        "",
        `# ${frameworkConfig.name} managed: uv start`,
        "# python / uv",
        ".venv/",
        `# ${frameworkConfig.name} managed: uv end`,
        "",
      ].join("\n"),
      "utf8",
    );

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun", "uv"],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).not.toContain("managed: uv start");
    expect(
      gitignore.match(new RegExp(`# ${frameworkConfig.name} managed: start`, "g"))?.length,
    ).toBe(1);
    expect(gitignore).toContain(".venv/");
  });

  test("adds headroom entries to the unified managed block", async () => {
    const root = await makeTempDir("mate-sync-headroom-gitignore-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun"],
      capabilities: [{ name: "headroom" }],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(
      gitignore.match(new RegExp(`# ${frameworkConfig.name} managed: start`, "g"))?.length,
    ).toBe(1);
    expect(gitignore).toContain(".headroom/");
  });

  test("removes headroom entries but keeps sticky managed entries when headroom is disabled", async () => {
    const root = await makeTempDir("mate-sync-headroom-gitignore-remove-");
    await fs.writeFile(
      path.join(root, ".gitignore"),
      [
        "node_modules/",
        "",
        `# ${frameworkConfig.name} managed: start`,
        "# headroom",
        ".headroom/",
        `# ${frameworkConfig.name} managed: end`,
        "",
      ].join("\n"),
      "utf8",
    );

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun"],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".graphify/*/graphify-out/cache/");
    expect(gitignore).not.toContain(".headroom/");
  });

  test("combines uv and headroom entries in one managed block", async () => {
    const root = await makeTempDir("mate-sync-uv-headroom-gitignore-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await updateProjectGitignore(root, {
      profiles: { default: { name: "default", allowedAgents: [] } },
      packageManagers: ["bun", "uv"],
      capabilities: [{ name: "headroom" }],
    });

    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(
      gitignore.match(new RegExp(`# ${frameworkConfig.name} managed: start`, "g"))?.length,
    ).toBe(1);
    expect(gitignore.match(new RegExp(`# ${frameworkConfig.name} managed: end`, "g"))?.length).toBe(
      1,
    );
    expect(gitignore).toContain(".venv/");
    expect(gitignore).toContain(".headroom/");
    expect(gitignore).toContain("node_modules/");
  });
});
