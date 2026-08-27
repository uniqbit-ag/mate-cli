// Show the active Mate companion paths in Claude Code.
import { resolveCompanionRuntime } from "../runtime/env";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { mateVersion } from "../runtime/install";
import type { HookEnv } from "./validate-artifact-path";

export interface BannerOutcome {
  exitCode: number;
  stdout: string;
}

/**
 * Resolves in-process from either source — no subprocess in either branch.
 * With `mate doctor` out of scope this is one of only two surfaces where a
 * drifted wrap becomes visible, so staleness is reported, never suppressed.
 */
export function buildBanner(env: HookEnv, cwd: string = process.cwd()): BannerOutcome {
  const { context, projection } = resolveCompanionRuntime(env, cwd);
  if (!context.repositoryPath || !context.companionPath) return { exitCode: 0, stdout: "" };

  const lines = [
    `mate v${env.MATE_VERSION || mateVersion()}`,
    `  repo:     ${context.repositoryPath}`,
    `  mate: ${context.companionPath}`,
  ];
  if (projection) {
    for (const note of projectionStalenessLines(projection, projectionFreshness(projection))) {
      lines.push(`  ${note}`);
    }
  }

  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: lines.join("\n") }) + "\n" };
}

// Plugin-shim entry.
export function run(): number {
  const outcome = buildBanner(process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
