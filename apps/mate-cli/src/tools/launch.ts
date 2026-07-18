import { FrameworkLauncher } from "../lib/orchestrator/launcher";
import type { FrameworkTool } from "../lib/orchestrator/tool";
import type { LaunchResult } from "../lib/orchestrator/types";

export interface LaunchInput {
  args: string[];
}

const DESCRIPTIONS: Record<string, string> = {
  claude:
    "Launch Claude Code through the framework with repository policy, projection enforcement, --add-dir wiring, and automatic companion Git synchronization.",
  opencode:
    "Launch OpenCode through the framework with repository policy, projection enforcement, and automatic companion Git synchronization.",
};

function createLaunchTool(
  toolName: "claude" | "opencode",
): FrameworkTool<LaunchInput, LaunchResult> {
  return {
    name: `launch-${toolName}`,
    description: DESCRIPTIONS[toolName],
    async execute({ args }) {
      return new FrameworkLauncher().launch({ tool: toolName, args });
    },
  };
}

export const launchClaude = createLaunchTool("claude");
export const launchOpenCode = createLaunchTool("opencode");
