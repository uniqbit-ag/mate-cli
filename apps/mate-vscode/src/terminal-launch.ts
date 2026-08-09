export type SupportedAgent = "opencode" | "claude";

export interface PairingLaunchContext {
  repositoryId: string;
  repositoryPath: string;
  companionPath: string;
}

export interface TerminalLaunchPlan {
  name: string;
  cwd: string;
  env: Record<string, string>;
  commandLine: string;
}

const AGENT_COMMAND: Record<SupportedAgent, string> = {
  opencode: "mate opencode",
  claude: "mate claude",
};

const AGENT_LABEL: Record<SupportedAgent, string> = {
  opencode: "OpenCode",
  claude: "Claude",
};

/**
 * Builds terminal launch options for a Mate-aware agent. No inventory path
 * is ever interpolated into a shell command string — paths travel only
 * through `cwd`/`env`, so this plan is identical on macOS, Linux, and
 * Windows; {@link platform} exists so callers/tests can assert that.
 */
export function buildTerminalLaunchPlan(
  agent: SupportedAgent,
  pairing: PairingLaunchContext,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunchPlan {
  void platform;
  return {
    name: `Mate ${AGENT_LABEL[agent]} · ${pairing.repositoryId}`,
    cwd: pairing.repositoryPath,
    env: {
      MATE_REPO_PATH: pairing.repositoryPath,
      MATE_ARTIFACT_PATH: pairing.companionPath,
      MATE_REPO_ID: pairing.repositoryId,
    },
    commandLine: AGENT_COMMAND[agent],
  };
}
