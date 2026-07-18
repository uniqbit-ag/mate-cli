import { existsSync } from "node:fs";

import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import { type AdapterContext, LaunchAdapter } from "./base";

export class ClaudeAdapter extends LaunchAdapter {
  readonly toolName = "claude";
  readonly interactive = true;

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

    return [
      "--add-dir",
      context.companionPath,
      "--append-system-prompt",
      buildCompanionGuidance(context),
      ...settingsArgs,
      ...mcpConfigArgs,
      ...args,
    ];
  }

  extendEnvironment(_context: AdapterContext): NodeJS.ProcessEnv {
    return {
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
    };
  }

  protected headroomEnv(
    context: AdapterContext,
    port: number,
    _companionPath: string,
  ): NodeJS.ProcessEnv {
    const project = encodeURIComponent(context.repository.id);
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/p/${project}`,
    };
  }
}
