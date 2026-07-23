import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import { parse } from "smol-toml";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { LaunchPreflightError } from "../types";
import { type AdapterContext, LaunchAdapter, type PreparedLaunch } from "./base";

const execFile = promisify(execFileCallback);
const MINIMUM_CODEX_VERSION = "0.145.0";

export function assertSupportedCodexVersion(output: string): void {
  const installed = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!installed || semver.lt(installed, MINIMUM_CODEX_VERSION)) {
    throw new LaunchPreflightError(
      `Codex CLI ${MINIMUM_CODEX_VERSION} or newer is required${installed ? ` (found ${installed})` : ""}. Run \`codex update\` and retry.`,
    );
  }
}

function hasAddDirArg(args: string[], companionPath: string): boolean {
  return args.some(
    (arg, index) =>
      arg === `--add-dir=${companionPath}` ||
      (arg === "--add-dir" && args[index + 1] === companionPath),
  );
}

function readCompanionInstructions(companionPath: string): string {
  try {
    return fs.readFileSync(path.join(companionPath, "AGENTS.md"), "utf8").trim();
  } catch {
    return "";
  }
}

function configOverrides(args: string[]): string[] {
  const overrides: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "--config" || arg === "-c") {
      if (args[index + 1]) overrides.push(args[index + 1]!);
      index += 1;
    } else if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      overrides.push(arg.slice(arg.indexOf("=") + 1));
    }
  }
  return overrides;
}

function assertNoManagedConfigOverrides(context: AdapterContext, args: string[]): void {
  const tokenSaveEnabled = context.capabilities.some(
    (capability) => capability.name === "tokensave",
  );
  for (const override of configOverrides(args)) {
    const rawKey = override.split("=", 1)[0]!.trim();
    const key = rawKey
      .split(".")
      .map((segment) => segment.trim().replace(/^(['"])(.*)\1$/, "$2"))
      .join(".");
    const managed =
      key === "developer_instructions" ||
      (tokenSaveEnabled &&
        (key === "mcp_servers" ||
          key === "mcp_servers.tokensave" ||
          key.startsWith("mcp_servers.tokensave.")));
    if (managed) {
      throw new LaunchPreflightError(
        `Codex config key \`${key}\` is managed by Mate and cannot be overridden in \`mate codex\` arguments.`,
      );
    }
  }
}

function isCompatibleTokenSaveConfig(content: string): boolean {
  const config = parse(content) as {
    mcp_servers?: Record<string, unknown>;
  };
  const tokenSave = config.mcp_servers?.tokensave;
  if (tokenSave === undefined) return true;
  if (!tokenSave || typeof tokenSave !== "object" || Array.isArray(tokenSave)) return false;

  const entry = tokenSave as Record<string, unknown>;
  return (
    entry.command === "tokensave" &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === "serve"
  );
}

export class CodexAdapter extends LaunchAdapter {
  readonly toolName = "codex";
  readonly interactive = true;

  async validateLaunch(_context: AdapterContext): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await execFile("codex", ["--version"], { encoding: "utf8" }));
    } catch {
      throw new LaunchPreflightError(
        "Codex CLI was not found. Install Codex, authenticate it, then retry `mate codex`.",
      );
    }
    assertSupportedCodexVersion(stdout);

    if (_context.capabilities.some((capability) => capability.name === "tokensave")) {
      const projectConfig = path.join(_context.repository.path, ".codex", "config.toml");
      try {
        const content = fs.readFileSync(projectConfig, "utf8");
        if (!isCompatibleTokenSaveConfig(content)) {
          throw new LaunchPreflightError(
            `Project Codex config ${projectConfig} defines a conflicting TokenSave MCP server. Remove or rename that project-local entry before using Mate's TokenSave capability.`,
          );
        }
      } catch (error) {
        if (error instanceof LaunchPreflightError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  buildArgs(context: AdapterContext, args: string[]): string[] {
    assertNoManagedConfigOverrides(context, args);
    const companionInstructions = readCompanionInstructions(context.companionPath);
    const guidance = [buildCompanionGuidance(context), companionInstructions]
      .filter(Boolean)
      .join("\n\n");

    return [
      "--config",
      `developer_instructions=${JSON.stringify(guidance)}`,
      ...(hasAddDirArg(args, context.companionPath) ? [] : ["--add-dir", context.companionPath]),
      ...this.tokensaveArgs(context),
      ...args,
    ];
  }

  private tokensaveArgs(context: AdapterContext): string[] {
    if (!context.capabilities.some((capability) => capability.name === "tokensave")) return [];
    return [
      "--config",
      'mcp_servers.tokensave.command="tokensave"',
      "--config",
      'mcp_servers.tokensave.args=["serve"]',
    ];
  }

  protected headroomWrapper(
    _context: AdapterContext,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): PreparedLaunch {
    return {
      command: "headroom",
      args: ["wrap", "codex", "--no-context-tool", "--", ...args],
      env: {
        ...env,
        HEADROOM_TELEMETRY: "off",
        HEADROOM_OUTPUT_SHAPER: "1",
      },
    };
  }
}
