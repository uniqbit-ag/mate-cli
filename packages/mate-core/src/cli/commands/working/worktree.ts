import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  collectWorkspaceInventory,
  type WorkspaceInventoryV1,
} from "../../../lib/orchestrator/workspace-inventory";
import {
  createChangeWorktrees,
  createWorksetWorktrees,
  NOT_CREATED,
  pruneWorksetWorktrees,
  type PruneResult,
  type WorktreeResult,
} from "../../../lib/workset/worktree";
import { errorMessage } from "../../../runtime/error-message";
import { gitEnvironment } from "../../../runtime/companion-git";
import { readCompanionWorksetStages } from "../studio/payload";

const execFileAsync = promisify(execFile);

const n = FRAMEWORK_NAME;
const USAGE = [
  `${n} working worktree: usage: ${n} working worktree <workset-id> [--companion <path>] [--no-install] [--json]`,
  `${n} working worktree: usage: ${n} working worktree --change <change> [--companion <path>] [--no-install] [--json]`,
  `${n} working worktree: usage: ${n} working worktree prune [--companion <path>] [--json]`,
].join("\n");

export interface WorkingWorktreeDeps {
  cwd?: string;
  /** The checkout's own root and its main worktree's root; null outside Git. */
  checkoutRoots?: (cwd: string) => Promise<string[] | null>;
  collectInventory?: () => Promise<WorkspaceInventoryV1>;
  create?: typeof createWorksetWorktrees;
  createForChange?: typeof createChangeWorktrees;
  prune?: typeof pruneWorksetWorktrees;
  worksetStages?: typeof readCompanionWorksetStages;
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function checkoutRoots(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
      { cwd, env: gitEnvironment() },
    );
    const [top, commonDir] = stdout.trim().split("\n");
    if (!top || !commonDir) return null;
    // From a linked worktree, the main checkout is the one paired with the companion.
    return [...new Set(await Promise.all([top, path.dirname(commonDir)].map(canonicalPath)))];
  } catch {
    return null;
  }
}

type Parsed = {
  companion?: string;
  install: boolean;
  json: boolean;
} & ({ target: string } | { change: string });

function parse(argv: string[]): Parsed | null {
  const positional: string[] = [];
  let companion: string | undefined;
  let change: string | undefined;
  let install = true;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--companion") {
      companion = argv[++index];
      if (!companion) return null;
    } else if (arg === "--change") {
      change = argv[++index];
      if (!change) return null;
    } else if (arg === "--no-install") install = false;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return null;
    else positional.push(arg);
  }
  const rest = { ...(companion ? { companion } : {}), install, json };
  if (change) return positional.length === 0 ? { change, ...rest } : null;
  const [target] = positional;
  if (positional.length !== 1 || !target) return null;
  if (target === "prune" && !install) return null;
  return { target, ...rest };
}

/** `--companion` when given, else the single companion the current checkout is paired with. */
async function resolveCompanion(
  explicit: string | undefined,
  deps: WorkingWorktreeDeps,
): Promise<{ companion: string } | { error: string }> {
  if (explicit) {
    const companion = path.resolve(explicit);
    try {
      await fs.access(path.join(companion, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"));
      return { companion };
    } catch {
      return { error: `${companion} is not a Companion Repository` };
    }
  }
  const cwd = deps.cwd ?? process.cwd();
  const roots = await (deps.checkoutRoots ?? checkoutRoots)(cwd);
  if (!roots) return { error: `${cwd} is not inside a Git working tree; pass --companion <path>` };
  const inventory = await (deps.collectInventory ?? collectWorkspaceInventory)();
  const paired = await Promise.all(
    inventory.pairings.map(async (pairing) =>
      roots.includes(await canonicalPath(pairing.repository.path)) ? pairing.companionPath : null,
    ),
  );
  const companions = [...new Set(paired.filter((entry): entry is string => entry !== null))];
  if (companions.length === 1) return { companion: companions[0]! };
  if (companions.length === 0) {
    return { error: `${roots[0]} is not linked to a companion; pass --companion <path>` };
  }
  return {
    error: `${roots[0]} is paired with several companions (${companions.join(", ")}); pass --companion <path>`,
  };
}

function reportProblems(diagnostics: string[], warnings: string[]): void {
  for (const line of diagnostics) console.error(`${n} working worktree: ${line}`);
  for (const line of warnings) console.error(`${n}: warning: ${line}`);
}

function printCreated(result: WorktreeResult): void {
  for (const entry of result.repositories) {
    // A worktree that could not be created has nothing to describe but its error.
    if (entry.install.reason !== NOT_CREATED) {
      const prefix = `${n}: ${entry.repository}:`;
      process.stdout.write(
        `${prefix} ${entry.action} ${entry.path} on ${entry.branch} (from ${entry.checkout})\n`,
      );
      const { command, outcome, reason } = entry.install;
      process.stdout.write(
        outcome === "skipped"
          ? `${prefix} install skipped (${reason})\n`
          : `${prefix} install ${command} ${outcome}\n`,
      );
      if (entry.missingEnv.length > 0) {
        process.stdout.write(
          `${prefix} env files missing in the worktree (not copied): ${entry.missingEnv.join(", ")}\n`,
        );
      }
    }
    if (entry.error) console.error(`${n} working worktree: ${entry.repository}: ${entry.error}`);
  }
}

function printPruned(result: PruneResult): void {
  for (const entry of result.removed) {
    process.stdout.write(`${n}: removed ${entry.path} (${entry.workset}, ${entry.repository})\n`);
  }
  for (const entry of result.kept) {
    process.stdout.write(
      `${n}: kept ${entry.path} (${entry.workset}, ${entry.repository}): ${entry.reason}\n`,
    );
  }
  if (result.removed.length === 0 && result.kept.length === 0) {
    process.stdout.write(`${n}: no worktree of a Done Workset to prune\n`);
  }
}

/**
 * `mate working worktree <workset-id>` creates or reuses the Workset's worktree in each
 * Working Repository; `--change <change>` does so for the Workset the change resolves to;
 * `mate working worktree prune` removes those of Done Worksets.
 */
export async function runWorkingWorktreeCommand(
  argv: string[],
  deps: WorkingWorktreeDeps = {},
): Promise<void> {
  const parsed = parse(argv);
  if (!parsed) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const resolved = await resolveCompanion(parsed.companion, deps);
  if ("error" in resolved) {
    console.error(`${n} working worktree: ${resolved.error}`);
    process.exitCode = 1;
    return;
  }
  const { companion } = resolved;
  try {
    if ("target" in parsed && parsed.target === "prune") {
      const { worksets } = await (deps.worksetStages ?? readCompanionWorksetStages)(companion);
      const done = worksets
        .filter((entry) => entry.derived.stage === "done")
        .map((entry) => entry.record);
      const result = await (deps.prune ?? pruneWorksetWorktrees)(companion, done);
      reportProblems([], result.warnings);
      if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else printPruned(result);
      return;
    }
    const options = { install: parsed.install, streamInstall: !parsed.json };
    const result =
      "change" in parsed
        ? await (deps.createForChange ?? createChangeWorktrees)(companion, parsed.change, options)
        : await (deps.create ?? createWorksetWorktrees)(companion, parsed.target, options);
    reportProblems(result.diagnostics, result.warnings);
    if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printCreated(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`${n} working worktree: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
