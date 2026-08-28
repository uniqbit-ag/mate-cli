import { FRAMEWORK_NAME } from "../../framework";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repo-local-registry";
import { unwrapWorkingRuntimeDocuments } from "../../lib/orchestrator/working-repo-projection";

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

  const result = await unwrap(repository.path);
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
  console.log(`\`${FRAMEWORK_NAME} claude\` and \`${FRAMEWORK_NAME} opencode\` work here again.`);
}
