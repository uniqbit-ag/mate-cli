import { FRAMEWORK_NAME } from "../../framework";
import { attendedLockOptions } from "../../lib/orchestrator/companion-git-sync";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repo-local-registry";
import { unwrapWorkingRuntimeDocuments } from "../../lib/orchestrator/working-repo-projection";
import { withCompanionLock } from "../../runtime/companion-lock";
import { readProjectionFile } from "../../runtime/projection";

export interface UnwrapCommandDependencies {
  findRepoLocalLinkedRepository?: typeof findRepoLocalLinkedRepository;
  unwrapWorkingRuntimeDocuments?: typeof unwrapWorkingRuntimeDocuments;
}

export const unwrapCommandDeps: Required<UnwrapCommandDependencies> = {
  findRepoLocalLinkedRepository,
  unwrapWorkingRuntimeDocuments,
};

/**
 * Withdraws the runtime documents `mate wrap` placed and nothing else: the
 * Projection Root, the Repository Link and the companion link all stay, so a
 * Managed Session resolves exactly as it did before the wrap. That is what
 * separates this from `mate working cleanup`, which removes Mate's whole local
 * integration including the link.
 *
 * Takes no companion. The manifest at the Projection Root records what was
 * placed, so unwrapping needs no answer to which companion placed it — which
 * also means it still works when the companion is gone.
 */
export async function runUnwrapCommand(
  argv: string[] = [],
  cwd: string = process.cwd(),
  deps: UnwrapCommandDependencies = {},
): Promise<void> {
  const findRepository =
    deps.findRepoLocalLinkedRepository ?? unwrapCommandDeps.findRepoLocalLinkedRepository;
  const unwrap =
    deps.unwrapWorkingRuntimeDocuments ?? unwrapCommandDeps.unwrapWorkingRuntimeDocuments;

  if (argv.length > 0) {
    console.error(`${FRAMEWORK_NAME}: usage: ${FRAMEWORK_NAME} unwrap`);
    process.exitCode = 1;
    return;
  }

  const repository = await findRepository(cwd);
  if (!repository) {
    console.error(
      `${FRAMEWORK_NAME}: this directory is not a working repository linked to a companion.`,
    );
    process.exitCode = 1;
    return;
  }

  /**
   * Under the lock of the companion the projection names, so a prepare or sync
   * for it cannot rewrite the manifest mid-withdrawal. No companion, no lock:
   * unwrapping must still work when the companion is gone.
   */
  const companionPath = readProjectionFile(repository.path)?.projection.companionPath;
  const locked = companionPath
    ? await withCompanionLock(companionPath, attendedLockOptions(companionPath), () =>
        unwrap(repository.path),
      )
    : { acquired: true as const, value: await unwrap(repository.path) };
  if (!locked.acquired) {
    console.error(`${FRAMEWORK_NAME}: another companion synchronization is still running.`);
    process.exitCode = 1;
    return;
  }

  const result = locked.value;
  if (result.kind === "failed") {
    console.error(
      `${FRAMEWORK_NAME}: failed to withdraw ${result.document} for ${repository.id}: ${result.error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.kind === "absent") {
    console.log(`Not wrapped: ${repository.id}`);
    return;
  }

  console.log(`Unwrapped ${repository.id}`);
  for (const document of result.documents) {
    console.log(`  Withdrawn: ${document}`);
  }
  if (result.copies.length > 0) {
    console.log(`  Withdrawn: ${result.copies.length} companion copies under .opencode/`);
  }
  console.log(
    `The next \`${FRAMEWORK_NAME} claude\` or \`${FRAMEWORK_NAME} opencode\` wraps this repository again.`,
  );
}
