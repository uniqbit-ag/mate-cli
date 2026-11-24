import { spawn, spawnSync } from "node:child_process";

import { resolveCommandOnPath } from "../../tools/setup/utils";
import { withoutMateWrapperDirs } from "../package-paths";

export const TRIAGE_AGENTS = ["claude", "opencode"] as const;
export type TriageAgent = (typeof TRIAGE_AGENTS)[number];

export const TRIAGE_AGENT_NAMES: Record<TriageAgent, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
};

export interface FoundAgent {
  agent: TriageAgent;
  binary: string;
  /** First line of `--version`, or null when it fails. */
  version: string | null;
}

function probeVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0]?.trim() || null;
}

export function findAgents(pathValue: string): FoundAgent[] {
  const searchPath = withoutMateWrapperDirs(pathValue);
  return TRIAGE_AGENTS.flatMap((agent) => {
    const binary = resolveCommandOnPath(agent, searchPath);
    return binary ? [{ agent, binary, version: probeVersion(binary) }] : [];
  });
}

/** Verified against Claude Code 2.1 (`claude [prompt]`) and OpenCode 2.2 (`opencode --prompt`). */
function agentArgs(agent: TriageAgent, prompt: string): string[] {
  return agent === "claude" ? [prompt] : ["--prompt", prompt];
}

/** Starts the agent's own CLI, never a Mate launch: triage must work when that launch is broken. */
export function launchAgent(
  options: Pick<FoundAgent, "agent" | "binary"> & { sessionDir: string; prompt: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, agentArgs(options.agent, options.prompt), {
      cwd: options.sessionDir,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
