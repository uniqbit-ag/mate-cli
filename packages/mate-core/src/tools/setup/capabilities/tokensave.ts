import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitInfoExcludePath } from "../git-utils";
import type { CapabilityPlugin } from "../plugin";
import { isCommandOnPath, runCommand, runShellCommand } from "../utils";
export { TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES } from "./tokensave-shared";

export const TOKENSAVE_SUPPORTED_AGENTS = new Set(["claude", "opencode"]);
export const TOKENSAVE_STORE_DIR = ".tokensave";
export const TOKENSAVE_MIN_RUST_VERSION = "1.91.0";
const TOKENSAVE_CLAUDE_MD_MARKER = "## MANDATORY: No Explore Agents When Tokensave Is Available";
const TOKENSAVE_STORE_EXCLUDE_ENTRY = `${TOKENSAVE_STORE_DIR}/`;
const TOKENSAVE_BREW_INSTALL_CMD = "brew install aovestdipaperino/tap/tokensave";
const TOKENSAVE_CARGO_INSTALL_CMD = "cargo install --locked tokensave";
const TOKENSAVE_SCOOP_INSTALL_CMD =
  "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave";

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
  rustcVersion(): TokensaveRunResult {
    const result = spawnSync("rustc", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0 && !result.error,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
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

// Global agent integration (MCP entry, session hooks, wildcard permission grant, and
// tokensave's own config bookkeeping) is owned by tokensave's installer — Mate never
// hand-edits ~/.tokensave/config.toml. Runs in setup mode only; the installer is
// idempotent, so re-running on every setup doubles as repair for stale global state.
function installTokensaveAgentIntegrations(providers: string[], cwd: string): void {
  const agents = providers.filter((p) => TOKENSAVE_SUPPORTED_AGENTS.has(p)).sort();
  for (const agent of agents) {
    const result = tokensaveDeps.run(
      ["install", "--agent", agent, "--git-hook", "no", "--wildcard-permissions"],
      cwd,
    );
    if (!result.ok) {
      const detail = result.stderr.trim();
      process.stderr.write(
        `tokensave: \`tokensave install --agent ${agent}\` failed${detail ? `: ${detail}` : ""} - continuing without global ${agent} integration\n`,
      );
    }
  }
}

function getCargoRustVersionError(): string | undefined {
  const result = tokensaveDeps.rustcVersion();
  const version = `${result.stdout}\n${result.stderr}`.match(/\brustc\s+(\d+)\.(\d+)\.(\d+)/);
  if (!result.ok || !version) {
    return `TokenSave requires Rust ${TOKENSAVE_MIN_RUST_VERSION} or newer. Install or upgrade Rust via https://rustup.rs.`;
  }

  const installed = version.slice(1, 4).map(Number);
  const minimum = TOKENSAVE_MIN_RUST_VERSION.split(".").map(Number);
  const firstDifference = installed.findIndex((part, index) => part !== minimum[index]);
  if (firstDifference !== -1 && installed[firstDifference] < minimum[firstDifference]) {
    return `TokenSave requires Rust ${TOKENSAVE_MIN_RUST_VERSION} or newer, but rustc ${version[1]}.${version[2]}.${version[3]} is installed. Upgrade Rust via https://rustup.rs.`;
  }
  return undefined;
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
      run: async () => {
        const rustVersionError = getCargoRustVersionError();
        if (rustVersionError) throw new Error(rustVersionError);
        await tokensaveDeps.runCommand("cargo", ["install", "--locked", "tokensave"]);
      },
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
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    process.stderr.write(
      `tokensave: install failed${detail} - install manually with \`${installPlan.command}\`\n`,
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

export function createTokensavePlugin(): CapabilityPlugin {
  return {
    id: "tokensave",
    kind: "capability",
    label: "TokenSave",
    description:
      "Enable TokenSave indexing in the repo and MCP access via companion-managed config.",
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

      // MCP access is provider-mediated: every active hosting provider gets the
      // server in its native config, and teardown bookkeeping removes it again.
      // The bare command name is resolved against PATH at spawn time by each
      // provider, so the registration never pins a since-moved/upgraded binary.
      await ctx.mcp?.register({
        name: "tokensave",
        command: "tokensave",
        args: ["serve"],
      });

      const targetPath = ctx.repoPath ?? ctx.companionPath;
      if (!(await ensureTokensaveInstalled(targetPath))) {
        return;
      }
      if (ctx.mode === "setup") {
        installTokensaveAgentIntegrations(ctx.activeProviders, targetPath);
      }
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
        // Registration goes through ctx.mcp now. Teardown stays as a legacy
        // prune for entries written by releases that predate the bookkeeping
        // manifest.
        async apply(_ctx) {},
        async teardown(ctx) {
          await removeOpenCodeMcpServer(ctx.companionPath);
        },
      },
    },
  };
}
