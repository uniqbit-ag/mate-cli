import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { findRepoLocalLinkedRepository } from "../../../lib/orchestrator/repo-local-registry";
import { prepareSession, type PrepareResult } from "../../../lib/orchestrator/session-prepare";
import { isWorkingRepositoryWrapped } from "../../../lib/orchestrator/working-repo-projection";
import { readProjectionFile } from "../../../runtime/projection";
import { writeJsonStdout } from "../../write-json-stdout";
import { launchAmbiguityDeps } from "../shared/companion-selection";

export interface SessionPrepareArgs {
  repo: string;
  json: boolean;
  /** Fast-forward the companion first, then the local phase when it moved. */
  sync: boolean;
}

const USAGE = `Usage: ${FRAMEWORK_NAME} session prepare --repo <dir> [--json] [--sync]`;

function fail(message: string, usage = false): null {
  console.error(`${FRAMEWORK_NAME}: ${message}`);
  if (usage) console.error(USAGE);
  process.exitCode = 1;
  return null;
}

export function parseSessionPrepareArgs(
  argv: string[],
  cwd: string = process.cwd(),
): SessionPrepareArgs | { error: string } {
  const args: SessionPrepareArgs = { repo: cwd, json: false, sync: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    if (flag === "--json") {
      args.json = true;
    } else if (flag === "--repo") {
      const repo = inline ?? argv[++index];
      if (!repo) return { error: "--repo requires a directory" };
      args.repo = path.resolve(cwd, repo);
    } else if (flag === "--sync") {
      args.sync = true;
    } else {
      return { error: `unknown session prepare option: ${arg}` };
    }
  }
  return args;
}

export const sessionPrepareCommandDeps = {
  findRepoLocalLinkedRepository,
  isWorkingRepositoryWrapped,
  prepareSession,
  resolveLinkedCompanions: launchAmbiguityDeps.resolveLinkedCompanions,
};

async function resolveCompanionPath(repoPath: string): Promise<string | undefined> {
  const projected = readProjectionFile(repoPath)?.projection.companionPath;
  if (projected) return projected;
  return (await sessionPrepareCommandDeps.resolveLinkedCompanions(repoPath))[0]?.companionPath;
}

function printHuman(result: PrepareResult): void {
  for (const step of result.steps) {
    const detail = step.detail ? ` — ${step.detail}` : "";
    console.log(`  ${step.step}: ${step.outcome}${detail}`);
  }
  for (const warning of result.warnings) {
    console.error(`${FRAMEWORK_NAME}: warning: ${warning}`);
  }
}

/**
 * `mate session prepare`: a launch's preparation for a repository wrapped for
 * OpenCode, without the launch. Without `--sync` it touches no remote; with it,
 * it fast-forwards the companion and re-projects only when the companion moved.
 * Non-zero when the repository is not wrapped or a step failed; a Git conflict
 * or an offline remote is only a warning.
 */
export async function runSessionPrepareCommand(
  argv: string[],
  cwd: string = process.cwd(),
): Promise<PrepareResult | null> {
  const parsed = parseSessionPrepareArgs(argv, cwd);
  if ("error" in parsed) return fail(parsed.error, true);

  const deps = sessionPrepareCommandDeps;
  const repository = await deps.findRepoLocalLinkedRepository(parsed.repo);
  if (!repository || !(await deps.isWorkingRepositoryWrapped(repository.path, "opencode"))) {
    return fail(
      `${parsed.repo} is not wrapped for OpenCode. Run \`${FRAMEWORK_NAME} wrap\` there first.`,
    );
  }

  const companionPath = await resolveCompanionPath(repository.path);
  if (!companionPath) return fail(`no companion is linked to ${repository.id}.`);

  const result = await deps.prepareSession({
    runtime: "opencode",
    companionPath,
    repository,
    mode: parsed.sync ? "sync" : "local",
  });
  /** The failure's own error is for an in-process caller; the JSON names it per step. */
  const { failure: _failure, ...reported } = result;
  if (parsed.json) await writeJsonStdout(reported);
  else printHuman(result);
  if (!result.ok) process.exitCode = 1;
  return result;
}

export async function runSessionCommand(subcommand: string | undefined, rest: string[]) {
  if (subcommand === "prepare") {
    await runSessionPrepareCommand(rest);
    return;
  }
  fail(`unknown session subcommand: ${subcommand ?? ""}`.trimEnd(), true);
}
