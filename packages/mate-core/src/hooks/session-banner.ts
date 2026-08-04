// Show the active Mate companion paths in Claude Code.
import type { HookEnv } from "./validate-artifact-path";

export interface BannerOutcome {
  exitCode: number;
  stdout: string;
}

// Fail-soft outside managed sessions: no MATE_* env, no banner.
export function buildBanner(env: HookEnv): BannerOutcome {
  const repoPath = env.MATE_REPO_PATH;
  const artifactPath = env.MATE_ARTIFACT_PATH;
  if (!repoPath || !artifactPath) return { exitCode: 0, stdout: "" };

  const mateVersion = env.MATE_VERSION || "unknown";
  const message = `mate v${mateVersion}\n  repo:     ${repoPath}\n  mate: ${artifactPath}`;
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: message }) + "\n" };
}

// Plugin-shim entry.
export function run(): number {
  const outcome = buildBanner(process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
