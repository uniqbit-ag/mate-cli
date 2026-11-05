import { FRAMEWORK_NAME } from "../../../framework";
import { createStartupProgress } from "../../../lib/components/startup-progress";
import { syncCompanionGit } from "../../../lib/orchestrator/companion-git-sync";
import { LaunchPreflightError } from "../../../lib/orchestrator/types";
import { resolveCompanionRuntime } from "../../../runtime/env";
import { readCompanionPolicy } from "../../../runtime/policy";
import { resolveCompanionPath, resolveRepoPath } from "./tui";

export interface CompanionSyncDeps {
  resolveCompanionPath: typeof resolveCompanionPath;
  resolveProjectedCompanionPath: (cwd: string) => string | undefined;
  resolveRepoPath: typeof resolveRepoPath;
  readCompanionPolicy: typeof readCompanionPolicy;
  syncCompanionGit: typeof syncCompanionGit;
  createProgress: typeof createStartupProgress;
}

export const companionSyncDeps: CompanionSyncDeps = {
  resolveCompanionPath,
  resolveProjectedCompanionPath: (cwd) =>
    resolveCompanionRuntime(process.env, cwd).context.companionPath || undefined,
  resolveRepoPath,
  readCompanionPolicy,
  syncCompanionGit,
  createProgress: createStartupProgress,
};

/**
 * The Projection Root answers for a Wrapped Repository, which can never take
 * the launch path — so the command must resolve there too, not only through the
 * repo-local registry the launch uses.
 */
async function resolveCompanion(cwd: string): Promise<string | undefined> {
  const resolved = await companionSyncDeps.resolveCompanionPath(cwd);
  if (resolved) return resolved;
  return companionSyncDeps.resolveProjectedCompanionPath(cwd);
}

/**
 * @command mate companion sync
 * @description Runs the companion Git synchronization a launch preflight
 * performs, against the companion resolved for the current directory. Runs Git
 * interactively so credentials and conflicts can be answered.
 */
export async function runCompanionSyncCommand(): Promise<void> {
  const cwd = process.cwd();
  const companionPath = await resolveCompanion(cwd);
  if (!companionPath) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: no companion resolves for this directory. Run \`${FRAMEWORK_NAME} companion link\` first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  /** An explicit request does not override a companion configured not to have one. */
  if (!companionSyncDeps.readCompanionPolicy(companionPath).gitAutoMode) {
    process.stderr.write(
      [
        `${FRAMEWORK_NAME}: the companion's Git policy disables synchronization.`,
        `  companion: ${companionPath}`,
        `  Set \`git: auto\` in the companion's framework configuration to enable it.`,
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const repoPath = await companionSyncDeps.resolveRepoPath(cwd);

  const progress = companionSyncDeps.createProgress("Syncing companion");
  try {
    // Git may ask for credentials: a labelled hand-over, never a spinner.
    progress.handOver("git", "Syncing companion Git");
    const result = await companionSyncDeps.syncCompanionGit(
      companionPath,
      repoPath === companionPath ? undefined : repoPath,
      true,
    );
    progress.succeed("git");
    if (result.skipped) {
      process.stdout.write(
        `${FRAMEWORK_NAME}: ${companionPath} is not a Git working tree; nothing to synchronize.\n`,
      );
      return;
    }
    process.stdout.write(
      `${FRAMEWORK_NAME}: synchronized ${companionPath} (${result.changed ? "updated" : "no changes"}).\n`,
    );
  } catch (error) {
    progress.fail("git");
    if (error instanceof LaunchPreflightError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    progress.stop();
  }
}
