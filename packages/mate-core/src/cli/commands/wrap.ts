import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repository-link";
import type { ProjectionChangedPaths } from "../../lib/orchestrator/projection-types";
import { attendedLockOptions } from "../../lib/orchestrator/companion-git-sync";
import { runWrapPass, type WrapPassResult } from "../../lib/orchestrator/wrap-pass";
import { withCompanionLock } from "../../runtime/companion-lock";
import { WRAP_RUNTIMES } from "../../runtime/wrap-state";
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
  const { runtimes } = result;
  const tools = WRAP_RUNTIMES.filter((runtime) => runtimes.has(runtime));
  if (tools.length === 0) return;
  const plain = tools.map((tool) => `\`${tool}\``).join(", ");
  const managed = tools.map((tool) => `\`${FRAMEWORK_NAME} ${tool}\``).join(", ");
  console.log(
    `Start sessions yourself (${plain}) or through ${managed}; both work here. \`${FRAMEWORK_NAME} unwrap\` reverses this.`,
  );
  const pluginCapabilityIds = result.claudePluginCapabilities;
  if (runtimes.has("claude") && pluginCapabilityIds.length > 0) {
    const verb = pluginCapabilityIds.length === 1 ? "loads" : "load";
    console.log(
      `Note: ${listNames(pluginCapabilityIds)} ${verb} only in sessions started with \`${FRAMEWORK_NAME} claude\`.`,
    );
  }
}

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}
