import { existsSync } from "node:fs";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { getContextModePackageRoot, validateContextModePackage } from "../../context-mode-package";
import { getClaudePluginRoot, validateClaudePluginAssets } from "../../package-paths";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import { type AdapterContext, LaunchAdapter } from "./base";

export class ClaudeAdapter extends LaunchAdapter {
  readonly toolName = "claude";
  readonly interactive = true;

  async validateLaunch(context: AdapterContext): Promise<void> {
    // The bundled mate plugin carries the artifact-path guard; never launch a
    // managed session without it.
    try {
      validateClaudePluginAssets();
    } catch (error) {
      throw new Error(
        `Mate Claude plugin is unavailable: ${(error as Error).message}. Reinstall mate to repair it.`,
        { cause: error },
      );
    }

    if (context.capabilities.some((capability) => capability.name === "context-mode")) {
      try {
        await validateContextModePackage(context.companionPath);
      } catch (error) {
        throw new Error(
          `Claude context-mode plugin is unavailable: ${(error as Error).message} Repair it with \`mate companion setup\`.`,
          { cause: error },
        );
      }
    }
  }

  buildArgs(context: AdapterContext, args: string[]): string[] {
    // Load Mate-managed Claude config from companion settings when present,
    // layered on top of the user's user/project/local sources so global
    // skills and plugins still load. Only add the flags when the file
    // exists so a companion without generated settings still launches with
    // Claude's default discovery.
    const companionSettingsPath = getCompanionClaudeSettingsPath(context.companionPath);
    const settingsArgs = existsSync(companionSettingsPath)
      ? ["--setting-sources", "user,project,local", "--settings", companionSettingsPath]
      : [];

    // Load Mate-managed MCP servers from the companion `.mcp.json` when present.
    // It lives in the companion repo (not the working-repo cwd), so it must be
    // passed explicitly rather than relying on Claude's cwd auto-discovery.
    const companionMcpConfigPath = getCompanionClaudeMcpConfigPath(context.companionPath);
    const mcpConfigArgs = existsSync(companionMcpConfigPath)
      ? ["--mcp-config", companionMcpConfigPath]
      : [];
    const contextModeArgs = context.capabilities.some(
      (capability) => capability.name === "context-mode",
    )
      ? ["--plugin-dir", getContextModePackageRoot(context.companionPath)]
      : [];

    return [
      "--add-dir",
      context.companionPath,
      "--append-system-prompt",
      buildCompanionGuidance(context),
      ...settingsArgs,
      ...mcpConfigArgs,
      // Bundled mate plugin (hooks) resolved from the running mate-core
      // installation, coexisting with the context-mode plugin dir.
      "--plugin-dir",
      getClaudePluginRoot(),
      ...contextModeArgs,
      ...args,
    ];
  }

  extendEnvironment(_context: AdapterContext): NodeJS.ProcessEnv {
    return {
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    };
  }
}
