import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { getReactDoctorBinPath, getWrapperBinPath } from "../../lib/package-paths";
import { version } from "../../../package.json";
import { executeSetup, syncWorkingRepoClaudeSettings } from "../setup";

// Golden-fixture harness for the Runtime Surface refactor: runs the real
// `executeSetup` across a capability × runtime matrix and snapshots the
// effective runtime config content as parsed/normalized structures. The
// refactor must keep every snapshot green (behavior identity, design D5).

process.env.MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH = "1";

const CAPABILITIES = ["graphify", "tokensave", "context-mode", "react-doctor", "openspec"] as const;
const AGENT_SETS: string[][] = [["claude"], ["opencode"], ["claude", "opencode"]];

const tempRoots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeStub(binDir: string, name: string, source: string): Promise<void> {
  const stubPath = path.join(binDir, name);
  await fs.writeFile(stubPath, source, "utf8");
  await fs.chmod(stubPath, 0o755);
}

// Mimics the external CLIs setup shells out to, so the full executeSetup code
// path runs hermetically. Each stub reproduces the side effects the Runtime
// Surface must reconcile afterwards (agent-file sections, settings.json hooks,
// opencode.json plugin entries, skill trees with cwd-relative output paths).
async function installStubs(root: string): Promise<string> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });

  await writeStub(
    binDir,
    "openspec",
    [
      "#!/usr/bin/env bun",
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      "const skills = ['openspec-explore', 'openspec-propose', 'openspec-apply-change', 'openspec-archive-change'];",
      "const runtimeDirs = { claude: '.claude', opencode: '.opencode' };",
      "if (args[0] === 'init') {",
      "  const targetPath = args[args.length - 1];",
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
      "if (args[0] === 'update') process.exit(0);",
      "process.exit(1);",
      "",
    ].join("\n"),
  );

  await writeStub(
    binDir,
    "graphify",
    [
      "#!/usr/bin/env bun",
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('graphify 0.0.0-test'); process.exit(0); }",
      "if (args[0] !== 'install') process.exit(0);",
      "const platform = args[args.indexOf('--platform') + 1];",
      "const dirs = { claude: '.claude', opencode: '.opencode' };",
      "const agentFiles = { claude: 'CLAUDE.md', opencode: 'AGENTS.md' };",
      "const providerDir = dirs[platform];",
      "if (!providerDir) process.exit(1);",
      "const cwd = process.cwd();",
      "const skillDir = path.join(cwd, providerDir, 'skills', 'graphify');",
      "fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });",
      "fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\\ndescription: builds graphify-out artifacts\\n---\\nWrite chunks to ${PROJECT_ROOT}/graphify-out and read graphify-out later.\\n');",
      "fs.writeFileSync(path.join(skillDir, 'references', 'usage.md'), 'Outputs land in graphify-out by default.\\n');",
      "fs.writeFileSync(path.join(skillDir, 'references', 'github-and-merge.md'), 'Merge graphs into graphify-out of each clone.\\n');",
      "fs.appendFileSync(path.join(cwd, agentFiles[platform]), '\\n## graphify\\n\\nUse the graphify skill to explore the code graph.\\n');",
      "if (platform === 'claude') {",
      "  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });",
      "  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cwd + '/.claude/hooks/graphify-guard.sh' }] }] };",
      "  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2) + '\\n');",
      "}",
      "if (platform === 'opencode') {",
      "  fs.mkdirSync(path.join(cwd, '.opencode', 'plugins'), { recursive: true });",
      "  fs.writeFileSync(path.join(cwd, '.opencode', 'plugins', 'graphify.js'), 'export default {}\\n');",
      "  const cfgPath = path.join(cwd, '.opencode', 'opencode.json');",
      "  let cfg = {};",
      "  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}",
      "  cfg.plugin = [...(Array.isArray(cfg.plugin) ? cfg.plugin : []), '.opencode/plugins/graphify.js'];",
      "  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\\n');",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  // The rtk capability is disabled in every matrix cell, and its provider
  // teardown runs `rtk init -g --uninstall` against whatever `rtk` is on PATH.
  // Stub it so the developer's real global RTK integration is never touched.
  await writeStub(binDir, "rtk", ["#!/bin/sh", "exit 0", ""].join("\n"));

  await writeStub(
    binDir,
    "tokensave",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "tokensave 0.0.0-test"; fi',
      "exit 0",
      "",
    ].join("\n"),
  );

  await writeStub(
    binDir,
    "npm",
    [
      "#!/usr/bin/env bun",
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'install') process.exit(0);",
      "const cwd = process.cwd();",
      "let version = '0.0.0';",
      "try {",
      "  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));",
      "  version = Object.values(manifest.dependencies ?? {})[0] ?? version;",
      "} catch {}",
      "const pkgRoot = path.join(cwd, 'node_modules', 'context-mode');",
      "for (const dir of ['.claude-plugin', 'hooks', path.join('skills', 'context-mode'), path.join('build', 'adapters', 'opencode')]) {",
      "  fs.mkdirSync(path.join(pkgRoot, dir), { recursive: true });",
      "}",
      "fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'context-mode', version }, null, 2) + '\\n');",
      "fs.writeFileSync(path.join(pkgRoot, '.claude-plugin', 'plugin.json'), '{}\\n');",
      "fs.writeFileSync(path.join(pkgRoot, 'hooks', 'hooks.json'), '{}\\n');",
      "fs.writeFileSync(path.join(pkgRoot, 'skills', 'context-mode', 'SKILL.md'), 'context-mode skill\\n');",
      "fs.writeFileSync(path.join(pkgRoot, 'build', 'adapters', 'opencode', 'plugin.js'), 'export default {}\\n');",
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  return binDir;
}

interface Fixture {
  root: string;
  companionPath: string;
  globalConfigStore: GlobalConfigStore;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const binDir = await installStubs(root);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  const companionPath = path.join(root, "companion");
  await fs.mkdir(companionPath, { recursive: true });
  const globalConfigStore = new GlobalConfigStore(path.join(root, "home", ".mate", "config.yaml"));
  return { root, companionPath, globalConfigStore };
}

function normalize(value: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    return replacements.reduce((acc, [needle, token]) => acc.split(needle).join(token), value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        normalize(key, replacements) as string,
        normalize(entry, replacements),
      ]),
    );
  }
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// Skill trees are captured as relative-path → digest, except graphify's tree,
// whose content the output-path rewrite mutates and is captured verbatim.
async function collectTree(dir: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  let names: string[];
  try {
    names = await fs.readdir(dir, { recursive: true });
  } catch {
    return entries;
  }
  for (const name of names.toSorted()) {
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    const content = await fs.readFile(filePath);
    entries[name.split(path.sep).join("/")] =
      name.split(path.sep)[1] === "graphify" || name.startsWith("graphify")
        ? content.toString("utf8")
        : crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  }
  return entries;
}

// permissions.allow is order-insensitive for Claude; sort it so snapshots
// compare it as a set. Hook arrays keep their order (execution order matters).
function sortPermissionAllow(settings: unknown): unknown {
  const permissions = (settings as { permissions?: { allow?: unknown } } | null)?.permissions;
  if (permissions && Array.isArray(permissions.allow)) {
    permissions.allow = permissions.allow.toSorted();
  }
  return settings;
}

async function collectEffectiveState(fixture: Fixture): Promise<unknown> {
  const { companionPath, root } = fixture;
  const state = {
    claudeSettingsLocal: sortPermissionAllow(
      await readJson(path.join(companionPath, ".claude", "settings.local.json")),
    ),
    claudeMcpConfig: await readJson(path.join(companionPath, ".mcp.json")),
    opencodeConfig: await readJson(path.join(companionPath, ".opencode", "opencode.json")),
    opencodeTui: await readJson(path.join(companionPath, ".opencode", "tui.json")),
    claudeMd: await readText(path.join(companionPath, "CLAUDE.md")),
    agentsMd: await readText(path.join(companionPath, "AGENTS.md")),
    claudeSkills: await collectTree(path.join(companionPath, ".claude", "skills")),
    opencodeSkills: await collectTree(path.join(companionPath, ".opencode", "skills")),
    claudeHooks: await collectTree(path.join(companionPath, ".claude", "hooks")),
    opencodePlugins: await collectTree(path.join(companionPath, ".opencode", "plugins")),
  };
  // macOS: os.tmpdir() is a /var/folders symlink; subprocess cwd resolves to
  // the /private/var/folders realpath. Normalize both spellings.
  return normalize(state, [
    [await fs.realpath(root), "<root>"],
    [root, "<root>"],
    [getWrapperBinPath(), "<wrapper-bin>"],
  ]);
}

function runSetup(
  fixture: Fixture,
  agents: string[],
  capabilities: string[],
): ReturnType<typeof executeSetup> {
  return executeSetup(
    {
      allowedAgents: agents,
      capabilities: capabilities.map((name) => ({ name })),
      git: "default",
    },
    { cwd: fixture.companionPath, globalConfigStore: fixture.globalConfigStore },
  );
}

describe("runtime surface golden fixtures", () => {
  for (const capability of CAPABILITIES) {
    for (const agents of AGENT_SETS) {
      test(
        `setup ${capability} × ${agents.join("+")}`,
        async () => {
          const fixture = await makeFixture(`mate-golden-${capability}-`);
          await runSetup(fixture, agents, [capability]);
          expect(await collectEffectiveState(fixture)).toMatchSnapshot();
        },
        { timeout: 30000 },
      );
    }
  }

  test(
    "setup all capabilities × claude+opencode",
    async () => {
      const fixture = await makeFixture("mate-golden-all-");
      await runSetup(fixture, ["claude", "opencode"], [...CAPABILITIES]);
      expect(await collectEffectiveState(fixture)).toMatchSnapshot();
    },
    { timeout: 30000 },
  );

  // Teardown identity: a companion that already carries a capability's managed
  // entries, re-set-up with that capability deselected, must lose exactly the
  // managed entries.
  for (const capability of CAPABILITIES) {
    test(
      `teardown ${capability} × claude+opencode`,
      async () => {
        const fixture = await makeFixture(`mate-golden-teardown-${capability}-`);
        await runSetup(fixture, ["claude", "opencode"], [capability]);
        await runSetup(fixture, ["claude", "opencode"], []);
        expect(await collectEffectiveState(fixture)).toMatchSnapshot();
      },
      { timeout: 30000 },
    );
  }

  // Shared-file guard: dropping one runtime while graphify stays enabled must
  // keep shared agent-file guidance intact for the still-active runtime.
  test(
    "deselect opencode runtime with graphify enabled",
    async () => {
      const fixture = await makeFixture("mate-golden-drop-opencode-");
      await runSetup(fixture, ["claude", "opencode"], ["graphify"]);
      await runSetup(fixture, ["claude"], ["graphify"]);
      expect(await collectEffectiveState(fixture)).toMatchSnapshot();
    },
    { timeout: 30000 },
  );
});

// Working repos have their own Claude surface reconciled at launch time by
// syncWorkingRepoClaudeSettings (additionalDirectories, managed-hook and
// tokensave-append stripping, git excludes) — the working-repo-claude-settings
// spec this change modifies. Hubs have no runtime surface: setup refuses them
// before writing anything (guarded below).
describe("working repo golden fixtures", () => {
  async function makeWorkingRepo(fixture: Fixture): Promise<string> {
    const workingRepoPath = path.join(fixture.root, "working");
    await fs.mkdir(path.join(workingRepoPath, ".git", "info"), { recursive: true });
    await fs.mkdir(path.join(workingRepoPath, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(workingRepoPath, "CLAUDE.md"),
      [
        "# Project",
        "",
        "User notes.",
        "",
        "## MANDATORY: No Explore Agents When Tokensave Is Available",
        "",
        "Installer-appended block.",
        "",
      ].join("\n"),
      "utf8",
    );
    const staleCompanionPath = path.join(fixture.root, "stale-companion");
    await fixture.globalConfigStore.register(staleCompanionPath);
    await fs.writeFile(
      path.join(workingRepoPath, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "user-hook.sh" }] },
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: "companion/.claude/hooks/mate-session-banner" },
                ],
              },
            ],
          },
          permissions: {
            allow: ["User(entry)"],
            additionalDirectories: [staleCompanionPath, path.join(workingRepoPath, "keep")],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return workingRepoPath;
  }

  async function collectWorkingRepoState(fixture: Fixture, workingRepoPath: string) {
    const state = {
      settingsLocal: await readJson(path.join(workingRepoPath, ".claude", "settings.local.json")),
      claudeMd: await readText(path.join(workingRepoPath, "CLAUDE.md")),
      gitExclude: await readText(path.join(workingRepoPath, ".git", "info", "exclude")),
    };
    // Machine- and version-specific managed env values are tokenized so the
    // snapshots stay portable.
    return normalize(state, [
      [await fs.realpath(fixture.root), "<root>"],
      [fixture.root, "<root>"],
      [getWrapperBinPath(), "<wrapperBin>"],
      [getReactDoctorBinPath(), "<reactDoctorBin>"],
      [version, "<version>"],
    ]);
  }

  for (const capabilities of [["tokensave", "react-doctor"], []] as const) {
    test(
      `sync working repo with capabilities [${capabilities.join(", ")}]`,
      async () => {
        const fixture = await makeFixture("mate-golden-working-");
        const workingRepoPath = await makeWorkingRepo(fixture);
        const { config } = await runSetup(fixture, ["claude"], [...capabilities]);

        await syncWorkingRepoClaudeSettings(
          workingRepoPath,
          fixture.companionPath,
          config,
          fixture.globalConfigStore,
        );

        expect(await collectWorkingRepoState(fixture, workingRepoPath)).toMatchSnapshot();
      },
      { timeout: 30000 },
    );
  }

  test("hub roots set up providers only without companion surfaces", async () => {
    const fixture = await makeFixture("mate-golden-hub-");
    const configDir = path.join(fixture.companionPath, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      ["type: hub", "hub:", "  companions: []", ""].join("\n"),
      "utf8",
    );

    await runSetup(fixture, ["claude", "opencode"], ["tokensave"]);

    expect(await collectEffectiveState(fixture)).toMatchSnapshot();
  });
});
