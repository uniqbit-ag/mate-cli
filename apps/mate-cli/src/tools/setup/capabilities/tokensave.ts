import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitInfoExcludePath } from "../git-utils";
import type { CapabilityPlugin } from "../plugin";
import { isCommandOnPath, runCommand, runShellCommand } from "../utils";
export { TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES } from "./tokensave-shared";

export const TOKENSAVE_SUPPORTED_AGENTS = new Set(["claude", "codex", "opencode"]);
export const TOKENSAVE_STORE_DIR = ".tokensave";
const TOKENSAVE_CLAUDE_MD_MARKER = "## MANDATORY: No Explore Agents When Tokensave Is Available";
const TOKENSAVE_STORE_EXCLUDE_ENTRY = `${TOKENSAVE_STORE_DIR}/`;
const TOKENSAVE_BREW_INSTALL_CMD = "brew install aovestdipaperino/tap/tokensave";
const TOKENSAVE_CARGO_INSTALL_CMD = "cargo install tokensave";
const TOKENSAVE_SCOOP_INSTALL_CMD =
  "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave";

function getTokensaveConfigPath(): string {
  return path.join(process.env.HOME ?? "", ".tokensave", "config.toml");
}

interface CompanionOpenCodeSettings {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

function getCompanionOpenCodeConfigPath(companionPath: string): string {
  return path.join(companionPath, ".opencode", "opencode.json");
}

export interface TokensaveRunResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

export const tokensaveDeps = {
  run(args: string[], cwd: string): TokensaveRunResult {
    const result = spawnSync("tokensave", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0 && !result.error,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  },
  isCommandOnPath(command: string, pathValue: string): boolean {
    return isCommandOnPath(command, pathValue);
  },
  async runCommand(command: string, args: string[]): Promise<void> {
    await runCommand(command, args);
  },
  async runShellCommand(command: string): Promise<void> {
    await runShellCommand(command);
  },
  platform(): NodeJS.Platform {
    return process.platform;
  },
  pathValue(): string {
    return process.env.PATH ?? "";
  },
};

async function readCompanionOpenCodeSettings(
  companionPath: string,
): Promise<CompanionOpenCodeSettings> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(getCompanionOpenCodeConfigPath(companionPath), "utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as CompanionOpenCodeSettings;
    }
  } catch {
    /* absent or malformed */
  }
  return {};
}

async function addOpenCodeMcpServer(companionPath: string): Promise<void> {
  const configPath = getCompanionOpenCodeConfigPath(companionPath);
  const settings = await readCompanionOpenCodeSettings(companionPath);
  const mcp = { ...settings.mcp };
  mcp.tokensave = {
    type: "local",
    command: ["tokensave", "serve"],
    enabled: true,
  };
  settings.mcp = mcp;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function removeOpenCodeMcpServer(companionPath: string): Promise<void> {
  const configPath = getCompanionOpenCodeConfigPath(companionPath);
  const settings = await readCompanionOpenCodeSettings(companionPath);
  if (!settings.mcp || typeof settings.mcp !== "object") {
    return;
  }

  const mcp = { ...settings.mcp };
  delete mcp.tokensave;
  if (Object.keys(mcp).length > 0) {
    settings.mcp = mcp;
  } else {
    delete settings.mcp;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function cleanupRepoLocalTokensaveArtifacts(repoPath: string): Promise<void> {
  const claudeMdPath = path.join(repoPath, "CLAUDE.md");
  try {
    const content = await fs.readFile(claudeMdPath, "utf8");
    const idx = content.indexOf(TOKENSAVE_CLAUDE_MD_MARKER);
    if (idx !== -1) {
      const before = content.slice(0, idx).replace(/\s+$/, "");
      if (before.length > 0) {
        await fs.writeFile(claudeMdPath, before + "\n", "utf8");
      } else {
        await fs.unlink(claudeMdPath);
      }
    }
  } catch {
    /* not present */
  }

  for (const basename of ["CLAUDE.md", "AGENTS.md", ".mcp.json", "opencode.json"]) {
    const bakPath = path.join(repoPath, `${basename}.bak`);
    try {
      await fs.unlink(bakPath);
    } catch {
      /* not present */
    }
  }
}

async function tokensaveInstalled(repoPath: string): Promise<boolean> {
  const result = tokensaveDeps.run(["--version"], repoPath);
  return result.ok;
}

async function readTokensaveConfig(): Promise<string | null> {
  try {
    return await fs.readFile(getTokensaveConfigPath(), "utf8");
  } catch {
    return null;
  }
}

async function writeTokensaveConfig(content: string): Promise<void> {
  await fs.mkdir(path.dirname(getTokensaveConfigPath()), { recursive: true });
  await fs.writeFile(getTokensaveConfigPath(), content, "utf8");
}

async function updateTokensaveInstalledAgents(providers: string[]): Promise<void> {
  const content = await readTokensaveConfig();
  if (!content) return;

  const agents = providers.filter((p) => TOKENSAVE_SUPPORTED_AGENTS.has(p)).sort();
  if (agents.length === 0) return;

  const existingLine = content.match(/^installed_agents\s*=\s*\[([^\]]*)\]/m);
  if (!existingLine) return;

  const existingStr = existingLine[1];
  const existing = new Set(
    existingStr
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  );

  for (const agent of agents) {
    existing.add(agent);
  }

  const sorted = [...existing].sort();
  const newValue = `installed_agents = [${sorted.map((a) => `"${a}"`).join(", ")}]`;
  const updated = content.replace(existingLine[0], newValue);

  if (updated !== content) {
    await writeTokensaveConfig(updated);
  }
}

function getTokensaveInstallPlan(): { command: string; run: () => Promise<void> } | undefined {
  const pathValue = tokensaveDeps.pathValue();
  const platform = tokensaveDeps.platform();

  if (platform === "darwin" && tokensaveDeps.isCommandOnPath("brew", pathValue)) {
    return {
      command: TOKENSAVE_BREW_INSTALL_CMD,
      run: () => tokensaveDeps.runCommand("brew", ["install", "aovestdipaperino/tap/tokensave"]),
    };
  }

  if (platform === "win32" && tokensaveDeps.isCommandOnPath("scoop", pathValue)) {
    return {
      command: TOKENSAVE_SCOOP_INSTALL_CMD,
      run: () => tokensaveDeps.runShellCommand(TOKENSAVE_SCOOP_INSTALL_CMD),
    };
  }

  if (tokensaveDeps.isCommandOnPath("cargo", pathValue)) {
    return {
      command: TOKENSAVE_CARGO_INSTALL_CMD,
      run: () => tokensaveDeps.runCommand("cargo", ["install", "tokensave"]),
    };
  }

  return undefined;
}

export async function ensureTokensaveInstalled(repoPath: string): Promise<boolean> {
  if (await tokensaveInstalled(repoPath)) {
    return true;
  }

  const installPlan = getTokensaveInstallPlan();
  if (!installPlan) {
    process.stderr.write(
      "tokensave binary not found and no supported installer is available on PATH. Install it manually: https://github.com/aovestdipaperino/tokensave\n",
    );
    return false;
  }

  process.stdout.write(`tokensave binary not found. Installing with:\n  ${installPlan.command}\n`);
  try {
    await installPlan.run();
  } catch {
    process.stderr.write(
      `tokensave: install failed - install manually with \`${installPlan.command}\`\n`,
    );
    return false;
  }

  if (!(await tokensaveInstalled(repoPath))) {
    process.stderr.write(
      "tokensave install completed but the binary is still not available on PATH\n",
    );
    return false;
  }

  return true;
}

export async function ensureTokensaveStoreExcluded(repoPath: string): Promise<void> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) {
    return;
  }

  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    // Fresh repos may not have created info/exclude yet.
  }

  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(TOKENSAVE_STORE_EXCLUDE_ENTRY)) {
    return;
  }

  lines.push(TOKENSAVE_STORE_EXCLUDE_ENTRY);
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, lines.join("\n") + "\n", "utf8");
}

async function teardownDriver(repoPath: string, providers: string[]) {
  const agents = providers.filter((p) => TOKENSAVE_SUPPORTED_AGENTS.has(p));
  if (agents.length === 0) return;

  try {
    await fs.rm(path.join(repoPath, TOKENSAVE_STORE_DIR), { recursive: true, force: true });
  } catch {
    // not present
  }

  await cleanupRepoLocalTokensaveArtifacts(repoPath);
}

export const tokensavePlugin: CapabilityPlugin = {
  id: "tokensave",
  kind: "capability",
  label: "TokenSave",
  description: "Enable TokenSave indexing in the repo and MCP access via companion-managed config.",
  defaultSelected: false,
  isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "tokensave"),
  getInstallRequirements: () => {
    const plan = getTokensaveInstallPlan();
    return [
      {
        id: "capability:tokensave",
        label: "TokenSave CLI",
        group: "companion",
        source: "TokenSave capability",
        command: plan?.command ?? "cargo install tokensave",
        fingerprint: `tokensave:${plan?.command ?? "manual"}`,
        detect: () => tokensaveDeps.run(["--version"], process.cwd()).ok,
        install: async () => {
          if (!plan) {
            throw new Error(
              "No supported TokenSave installer is available (install tokensave manually)",
            );
          }
          await plan.run();
        },
        verify: () => tokensaveDeps.run(["--version"], process.cwd()).ok,
      },
    ];
  },
  async apply(ctx) {
    // Presence only: make sure the tokensave binary is installed so the graph can be
    // built later. The graph build itself (init/sync) lives in `mate cap index`, never
    // in setup or launch-time sync — keeping launch fast and indexing an explicit step.
    if (ctx.activeProviders.filter((p) => TOKENSAVE_SUPPORTED_AGENTS.has(p)).length === 0) return;
    const targetPath = ctx.repoPath ?? ctx.companionPath;
    if (!(await ensureTokensaveInstalled(targetPath))) {
      return;
    }
    await updateTokensaveInstalledAgents(ctx.activeProviders);
  },
  async teardown(ctx) {
    if (!ctx.repoPath) return;
    await teardownDriver(ctx.repoPath, ctx.activeProviders);
  },
  forProvider: {
    claude: {
      async apply(_ctx) {},
      async teardown(_ctx) {},
    },
    opencode: {
      async apply(ctx) {
        await addOpenCodeMcpServer(ctx.companionPath);
      },
      async teardown(ctx) {
        await removeOpenCodeMcpServer(ctx.companionPath);
      },
    },
  },
};
