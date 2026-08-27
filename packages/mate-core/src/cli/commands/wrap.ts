import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore, mergeWithDefaults } from "../../lib/orchestrator/config-store";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repo-local-registry";
import {
  projectWorkingRepository,
  projectWorkingRuntimeDocuments,
} from "../../lib/orchestrator/working-repo-projection";
import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { launchAmbiguityDeps } from "./shared/companion-selection";

export interface WrapCommandDependencies {
  findRepoLocalLinkedRepository?: typeof findRepoLocalLinkedRepository;
  projectWorkingRepository?: typeof projectWorkingRepository;
  projectWorkingRuntimeDocuments?: typeof projectWorkingRuntimeDocuments;
  renderWorkingRuntimeDocuments?: typeof renderWorkingRuntimeDocuments;
  resolveLinkedCompanions?: typeof launchAmbiguityDeps.resolveLinkedCompanions;
}

export const wrapCommandDeps: Required<WrapCommandDependencies> = {
  findRepoLocalLinkedRepository,
  projectWorkingRepository,
  projectWorkingRuntimeDocuments,
  renderWorkingRuntimeDocuments,
  resolveLinkedCompanions: (cwd: string) => launchAmbiguityDeps.resolveLinkedCompanions(cwd),
};

/** The companion's own selection, read from files: wrapping runs no setup pass. */
async function readCompanionConfig(companionPath: string) {
  return mergeWithDefaults(
    await new ConfigStore(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
    ).load(),
  );
}

/**
 * `--companion` is consumed by the dispatch gate before the command runs, so it
 * is parsed there too; this only rejects anything else.
 */
export function parseWrapArgs(argv: string[]): { companion?: string } | { error: string } {
  let companion: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--companion") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return { error: "--companion requires a path" };
      companion = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--companion=")) {
      const value = arg.slice("--companion=".length);
      if (!value) return { error: "--companion requires a path" };
      companion = value;
      continue;
    }
    return { error: `unknown wrap option: ${arg}` };
  }
  return companion === undefined ? {} : { companion };
}

/**
 * Writes the Working Repository's Projection Root and the documents the Agent
 * Runtimes discover by themselves, so an Unmanaged Session both resolves its
 * Repository Link and loads the readers that consult it. The companion has
 * already been settled by the dispatch gate, which honors `--companion`, the
 * launch environment, and the picker in that order; wrapping only makes the
 * answer durable.
 */
export async function runWrapCommand(
  argv: string[] = [],
  cwd: string = process.cwd(),
  deps: WrapCommandDependencies = {},
): Promise<void> {
  const findRepository =
    deps.findRepoLocalLinkedRepository ?? wrapCommandDeps.findRepoLocalLinkedRepository;
  const project = deps.projectWorkingRepository ?? wrapCommandDeps.projectWorkingRepository;
  const projectDocuments =
    deps.projectWorkingRuntimeDocuments ?? wrapCommandDeps.projectWorkingRuntimeDocuments;
  const renderDocuments =
    deps.renderWorkingRuntimeDocuments ?? wrapCommandDeps.renderWorkingRuntimeDocuments;
  const resolveLinked = deps.resolveLinkedCompanions ?? wrapCommandDeps.resolveLinkedCompanions;

  const parsed = parseWrapArgs(argv);
  if ("error" in parsed) {
    console.error(`${FRAMEWORK_NAME}: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const repository = await findRepository(cwd);
  if (!repository) {
    console.error(
      `${FRAMEWORK_NAME}: this directory is not a working repository linked to a companion.`,
    );
    console.error(`Run \`${FRAMEWORK_NAME} companion link\` first.`);
    process.exitCode = 1;
    return;
  }

  /**
   * The gate pins only on ambiguity, so the unambiguous case still resolves
   * here — a single Linked Companion needs no answer to have been recorded.
   */
  const companionPath =
    (parsed.companion && path.resolve(parsed.companion)) ??
    process.env.MATE_ARTIFACT_PATH ??
    (await resolveLinked(cwd))[0]?.companionPath;
  if (!companionPath) {
    console.error(`${FRAMEWORK_NAME}: no registered companion links ${repository.id}.`);
    console.error(`Run \`${FRAMEWORK_NAME} companion link\` first.`);
    process.exitCode = 1;
    return;
  }

  const result = await project(companionPath, repository);
  if (result.kind === "failed") {
    console.error(
      `${FRAMEWORK_NAME}: failed to write the projection for ${repository.id}: ${result.error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  /**
   * After the projection, never instead of it: a runtime document that cannot
   * be written fails the command while the projection already written stays.
   */
  const config = await readCompanionConfig(result.companionPath);
  const documents = await projectDocuments(
    result.companionPath,
    repository,
    config,
    await renderDocuments(result.companionPath, config, repository.path),
  );
  if (documents.kind === "failed") {
    console.error(
      `${FRAMEWORK_NAME}: failed to reconcile ${documents.document} for ${repository.id}: ${documents.error.message}`,
    );
    process.exitCode = 1;
    return;
  }

  const changed = result.kind === "written" || documents.kind === "written";
  console.log(
    changed
      ? `Wrapped ${repository.id} at ${result.projectionRoot}`
      : `Already wrapped: ${result.projectionRoot}`,
  );
  console.log(`  Companion: ${result.companionPath}`);
  for (const document of documents.documents) {
    console.log(`  Runtime:   ${document}`);
  }
}
