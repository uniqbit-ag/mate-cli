import { CompanionResolver } from "../../../lib/orchestrator/companion-resolver";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { selectCompanion } from "../../companion-selector";

export const launchAmbiguityDeps = {
  resolveCompanionMatches: async (cwd: string) =>
    (await new CompanionResolver(new GlobalConfigStore()).resolveWithDiagnostics(cwd))
      .ambiguousMatches,
  selectCompanion,
};

/**
 * Pins a companion selection into env vars when the current working repo is
 * linked from multiple companions. Commands that should respect an already
 * selected companion can call this before any context resolution.
 */
export async function ensureUnambiguousCompanion(
  cwd: string = process.cwd(),
  options: { reselect?: boolean } = {},
): Promise<boolean> {
  if (process.env.MATE_ARTIFACT_PATH && !options.reselect) return true;

  const ambiguousMatches = await launchAmbiguityDeps.resolveCompanionMatches(cwd);
  if (ambiguousMatches.length <= 1) return true;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "mate: this working repo is linked from multiple companions; re-run in a TTY to choose one, or set MATE_ARTIFACT_PATH.\n",
    );
    for (const match of ambiguousMatches) {
      process.stderr.write(`  - ${match.companionPath}\n`);
    }
    return false;
  }

  const chosen = await launchAmbiguityDeps.selectCompanion(ambiguousMatches);
  if (!chosen) {
    process.stderr.write("Aborted.\n");
    return false;
  }

  process.env.MATE_ARTIFACT_PATH = chosen.companionPath;
  process.env.MATE_REPO_ID = chosen.repositoryId;
  return true;
}
