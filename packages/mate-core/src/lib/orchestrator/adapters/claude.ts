import { buildCompanionGuidance } from "../../../playbooks/companion-guidance";
import { getContextModePackageRoot, validateContextModePackage } from "../../context-mode-package";
import { getClaudePluginRoot, validateClaudePluginAssets } from "../../package-paths";
import { type AdapterContext, LaunchAdapter } from "./base";

export class ClaudeAdapter extends LaunchAdapter {
  readonly toolName = "claude";
  readonly interactive = true;

  async validateLaunch(context: AdapterContext): Promise<void> {
    /** The bundled plugin carries the artifact-path guard; never launch without it. */
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

  /**
   * Plan in, flags out; decides nothing. `--append-system-prompt`, `--plugin-dir`
   * and context-mode are unconditional: no settings document can carry them.
   */
  buildArgs(context: AdapterContext, args: string[]): string[] {
    const delivery = context.claudeDelivery;
    if (!delivery) throw new Error("a Claude launch needs the launcher's delivery plan");
    const { plan, settingsPath, mcpConfigPath } = delivery;
    /** Layered on the user's own sources so global skills and plugins still load. */
    const settingsArgs =
      plan.hooks.owner !== "none" && settingsPath
        ? ["--setting-sources", "user,project,local", "--settings", settingsPath]
        : [];
    const addDirArgs = plan.dirAccess === "add-dir" ? ["--add-dir", context.companionPath] : [];
    const mcpConfigArgs =
      plan.mcp === "mcp-config" && mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [];
    const contextModeArgs = context.capabilities.some(
      (capability) => capability.name === "context-mode",
    )
      ? ["--plugin-dir", getContextModePackageRoot(context.companionPath)]
      : [];

    return [
      ...addDirArgs,
      "--append-system-prompt",
      buildCompanionGuidance(context),
      ...settingsArgs,
      ...mcpConfigArgs,
      /** The bundled plugin from the running install, beside context-mode's. */
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
