// Show the active Mate companion paths in Claude Code, and repair the
// companion's Git state before the session reads it.
import {
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
  type UnattendedSyncOptions,
} from "../runtime/companion-sync";
import { hasLaunchEnvironment, resolveCompanionRuntime } from "../runtime/env";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { mateVersion } from "../runtime/install";
import type { HookEnv } from "./validate-artifact-path";

export interface BannerOutcome {
  exitCode: number;
  stdout: string;
}

/**
 * Marks the copy a wrap inlines into the Working Repository's settings. A
 * managed launch loads the plugin's own copy *and* that document, and both
 * registrations resolve to the same command against the same environment, so
 * nothing inside the process tells them apart. The flag is what keeps the
 * banner from printing twice in exactly the session that is configured
 * correctly — the projected copy defers, the launch's own copy prints.
 */
export const PROJECTED_BANNER_FLAG = "--projected";

/**
 * Resolves in-process from either source — no subprocess in either branch.
 * With `mate doctor` out of scope this is one of only two surfaces where a
 * drifted wrap becomes visible, so staleness is reported, never suppressed.
 */
export function buildBanner(
  env: HookEnv,
  cwd: string = process.cwd(),
  argv: readonly string[] = [],
  syncOptions: UnattendedSyncOptions = {},
): BannerOutcome {
  if (argv.includes(PROJECTED_BANNER_FLAG) && hasLaunchEnvironment(env)) {
    return { exitCode: 0, stdout: "" };
  }

  const { context, projection } = resolveCompanionRuntime(env, cwd);
  if (!context.repositoryPath || !context.companionPath) return { exitCode: 0, stdout: "" };

  /**
   * Session start is the only moment at which the companion may move without
   * invalidating a read the session has already taken, so the repair happens
   * here and nowhere later. The launch-environment check comes first, so a
   * Managed Session pays nothing at all — not the freshness read, not the
   * policy read; and the consent gate is the operation's own.
   */
  const gitNotes = hasLaunchEnvironment(env)
    ? []
    : unattendedSyncStalenessLines(syncCompanionUnattended(context.companionPath, syncOptions));

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
  /** `systemMessage` only: the model must never be told to run the command. */
  for (const note of gitNotes) lines.push(`  ${note}`);

  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: lines.join("\n") }) + "\n" };
}

// Plugin-shim entry.
export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const outcome = buildBanner(process.env, process.cwd(), argv);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return outcome.exitCode;
}
