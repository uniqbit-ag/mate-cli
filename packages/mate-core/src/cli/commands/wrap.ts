import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repo-local-registry";
import type { ProjectionChangedPaths } from "../../lib/orchestrator/projection-types";
import { documentRuntime } from "../../runtime/runtime-document-manifest";
import { attendedLockOptions } from "../../lib/orchestrator/companion-git-sync";
import { runWrapPass, type WrapPassResult } from "../../lib/orchestrator/wrap-pass";
import { withCompanionLock } from "../../runtime/companion-lock";
import { launchAmbiguityDeps } from "./shared/companion-selection";

export interface WrapCommandDependencies {
  findRepoLocalLinkedRepository?: typeof findRepoLocalLinkedRepository;
  runWrapPass?: typeof runWrapPass;
  resolveLinkedCompanions?: typeof launchAmbiguityDeps.resolveLinkedCompanions;
}

export const wrapCommandDeps: Required<WrapCommandDependencies> = {
  findRepoLocalLinkedRepository,
  runWrapPass,
  resolveLinkedCompanions: (cwd: string) => launchAmbiguityDeps.resolveLinkedCompanions(cwd),
};

/** Counts rather than names: a companion folder can hold dozens of files. */
function reportChangedPaths(changed: ProjectionChangedPaths): void {
  if (changed.written.length > 0 || changed.removed.length > 0) {
    console.log(
      `  Copies:    ${changed.written.length} written, ${changed.removed.length} withdrawn under .opencode/`,
    );
  }
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
  const wrap = deps.runWrapPass ?? wrapCommandDeps.runWrapPass;
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
    (parsed.companion && path.resolve(parsed.companion)) ||
    process.env.MATE_ARTIFACT_PATH ||
    (await resolveLinked(cwd))[0]?.companionPath;
  if (!companionPath) {
    console.error(`${FRAMEWORK_NAME}: no registered companion links ${repository.id}.`);
    console.error(`Run \`${FRAMEWORK_NAME} companion link\` first.`);
    process.exitCode = 1;
    return;
  }

  /** Serialized with Session Prepare and every sync, which rewrite the same manifest. */
  const locked = await withCompanionLock(companionPath, attendedLockOptions(companionPath), () =>
    wrap(companionPath, repository),
  );
  const result: WrapPassResult = locked.acquired
    ? locked.value
    : { kind: "failed", message: "another companion synchronization is still running." };
  if (result.kind === "failed") {
    console.error(`${FRAMEWORK_NAME}: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    result.kind === "written"
      ? `Wrapped ${repository.id} at ${result.projectionRoot}`
      : `Already wrapped: ${result.projectionRoot}`,
  );
  console.log(`  Companion: ${result.companionPath}`);
  for (const document of result.documents) {
    console.log(`  Runtime:   ${document}`);
  }
  for (const warning of result.warnings) {
    console.error(`${FRAMEWORK_NAME}: warning: ${warning}`);
  }
  reportChangedPaths(result.changed);
  /**
   * Said at the moment the mode is switched, not left to be discovered at the
   * next launch: a Claude wrap makes `mate claude` refuse here, and the operator
   * has no other way to learn that from a successful command. `mate opencode`
   * keeps working, because its launch is itself a wrap.
   */
  /** `documents` are OS paths; the runtime is read from the POSIX manifest key. */
  const claudeWrapped = result.documents.some(
    (document) => documentRuntime(document.split(path.sep).join("/")) === "claude",
  );
  console.log(
    claudeWrapped
      ? `Start Claude sessions yourself now: \`claude\`. \`${FRAMEWORK_NAME} claude\` does not run in a Claude-wrapped repository — \`${FRAMEWORK_NAME} unwrap\` reverses this. \`opencode\` and \`${FRAMEWORK_NAME} opencode\` both work here.`
      : `Start sessions yourself now: \`opencode\`, or \`${FRAMEWORK_NAME} opencode\`. \`${FRAMEWORK_NAME} unwrap\` reverses this.`,
  );
}
