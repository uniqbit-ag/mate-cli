import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  companionTicketFormat,
  TICKETS_OFF,
  type TicketFormat,
} from "../../../lib/delivery/branches";
import type { DeliveryEnvironment } from "../../../lib/delivery/environment";
import { recordDelivery, type DeliveryRefusal } from "../../../lib/delivery/record-delivery";
import { isJiraKey, normalizeJiraKey, sameRepository } from "../../../lib/delivery/record";
import { resolveForCapability } from "../../../lib/orchestrator/framework-context";
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
  type UmbrellaWorktreeResult,
  type WorktreeResult,
} from "../../../lib/workset/worktree";
import { attributeCurrentSession } from "../../../lib/session-attribution";
import { errorMessage } from "../../../runtime/error-message";
import { gitEnvironment } from "../../../runtime/companion-git";
import { resolveDeliveryEnvironment } from "../artifact/delivery/environment";
import { sharedRefusalMessage } from "../artifact/delivery/output";
import { ensureUnambiguousCompanion, launchAmbiguityDeps } from "../shared/companion-selection";
import { readCompanionWorksetStages } from "../studio/payload";

const execFileAsync = promisify(execFile);

const n = FRAMEWORK_NAME;
const USAGE = [
  `${n} working worktree: usage: ${n} working worktree <workset-id> [--ticket <KEY>] [--companion <path>] [--no-install] [--json]`,
  `${n} working worktree: usage: ${n} working worktree --change <change> [--enter] [--ticket <KEY>] [--companion <path>] [--no-install] [--json]`,
  `${n} working worktree: usage: ${n} working worktree prune [--companion <path>] [--json]`,
].join("\n");

/** How the current Agent Runtime moves its session into the worktree; the command never moves it. */
export interface EnterInstruction {
  runtime: "claude" | "opencode" | "unknown";
  action: "tool" | "handoff";
  tool?: "EnterWorktree" | "mate_enter_worktree";
  /** The current Working Repository's worktree; absent when it has none or it is unknown. */
  path?: string;
  reason?: string;
}

/** The current Working Repository's worktree, its branch recorded; or why nothing was recorded. */
export type RecordedBranch =
  | { repository: string; branch: string; path: string }
  /**
   * An Umbrella Repository's mirrored worktree on the Workset `branch`: `repositories` were
   * recorded, `failed` names the rest. OpenCode moves the session into `path`; any other
   * runtime hands off to a new session there, for the reason `handoff`.
   */
  | {
      handoff: string;
      path: string;
      branch?: string;
      repositories: string[];
      failed?: string[];
    }
  | { skipped: string }
  | { failed: string[] };

export interface WorkingWorktreeDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Records the current Working Repository's worktree branch as the change's delivery. */
  recordBranch?: (
    companion: string,
    change: string,
    result: WorktreeResult,
    cwd: string,
  ) => Promise<RecordedBranch>;
  /** The checkout's own root and its main worktree's root; null outside Git. */
  checkoutRoots?: (cwd: string) => Promise<string[] | null>;
  collectInventory?: () => Promise<WorkspaceInventoryV1>;
  create?: typeof createWorksetWorktrees;
  createForChange?: typeof createChangeWorktrees;
  prune?: typeof pruneWorksetWorktrees;
  worksetStages?: typeof readCompanionWorksetStages;
  /** The companion's ticket setting; `--ticket` is refused unless it is `jira`. */
  ticketFormat?: (companion: string) => Promise<TicketFormat>;
  /** Records the change, and the worktree it moves to, on the agent session this runs in. */
  attribute?: typeof attributeCurrentSession;
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
  ticket?: string;
} & ({ target: string } | { change: string; enter: boolean });

function parse(argv: string[]): Parsed | null {
  const positional: string[] = [];
  let companion: string | undefined;
  let change: string | undefined;
  let ticket: string | undefined;
  let install = true;
  let json = false;
  let enter = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--companion") {
      companion = argv[++index];
      if (!companion) return null;
    } else if (arg === "--change") {
      change = argv[++index];
      if (!change) return null;
    } else if (arg === "--ticket") {
      ticket = argv[++index];
      if (!ticket) return null;
    } else if (arg === "--no-install") install = false;
    else if (arg === "--enter") enter = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return null;
    else positional.push(arg);
  }
  const rest = {
    ...(companion ? { companion } : {}),
    ...(ticket ? { ticket } : {}),
    install,
    json,
  };
  if (change) return positional.length === 0 ? { change, enter, ...rest } : null;
  const [target] = positional;
  if (positional.length !== 1 || !target || enter) return null;
  if (target === "prune" && (!install || ticket)) return null;
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
  // Outside Git, as in an Umbrella Repository, the folder itself pairs.
  const roots = await (deps.checkoutRoots ?? checkoutRoots)(cwd);
  const pairedCompanions = await pairedWith(roots ?? [await canonicalPath(cwd)], deps);
  // A registry entry naming a removed folder pairs with nothing; the repo-local link still holds.
  const companions =
    pairedCompanions.length > 0
      ? pairedCompanions
      : (await launchAmbiguityDeps.resolveLinkedCompanions(cwd)).map((m) => m.companionPath);
  const folder = roots?.[0] ?? cwd;
  if (companions.length === 1) return { companion: companions[0]! };
  if (companions.length === 0) {
    const where = roots
      ? "is not linked to a companion"
      : "is neither inside a Git working tree nor linked to a companion";
    return { error: `${folder} ${where}; pass --companion <path>` };
  }
  return {
    error: `${folder} is paired with several companions (${companions.join(", ")}); pass --companion <path>`,
  };
}

/** The companions whose registry pairs with one of the checkout's roots. */
async function pairedWith(roots: string[], deps: WorkingWorktreeDeps): Promise<string[]> {
  const inventory = await (deps.collectInventory ?? collectWorkspaceInventory)();
  const paired = await Promise.all(
    inventory.pairings.map(async (pairing) =>
      roots.includes(await canonicalPath(pairing.repository.path)) ? pairing.companionPath : null,
    ),
  );
  return [...new Set(paired.filter((entry): entry is string => entry !== null))];
}

/** As `mate artifact link <change> --branch <branch>` records it, for the current Working Repository. */
async function recordBranch(
  companion: string,
  change: string,
  result: WorktreeResult,
  cwd: string,
): Promise<RecordedBranch> {
  const environment = await resolveDeliveryEnvironment({
    ensureUnambiguousCompanion: () => ensureUnambiguousCompanion(cwd, { companion }),
    resolveContext: () => resolveForCapability(cwd),
  });
  if ("error" in environment) {
    return { failed: [environment.error ?? `cannot resolve the companion ${companion}`] };
  }
  const slug = environment.workingRepo?.slug;
  if (!slug && environment.workingRepo?.umbrellaChildren) {
    if (
      !result.umbrella ||
      !(await isSessionUmbrella(environment.workingRepo.path, result.umbrella))
    ) {
      return {
        skipped: `no child of the Umbrella Repository ${environment.workingRepo.path} got a worktree for ${result.workset}`,
      };
    }
    return recordUmbrella(environment, change, result, result.umbrella);
  }
  if (!slug) return { failed: ["the Working Repository has no origin remote to identify it"] };
  const entry = result.repositories.find((candidate) => sameRepository(candidate.repository, slug));
  if (!entry) return { skipped: `${slug} got no worktree for ${result.workset}` };
  const outcome = await recordDelivery(environment, {
    changes: [change],
    repository: slug,
    edit: { delivery: { branch: entry.branch, direct: false } },
  });
  if ("refusal" in outcome) return { failed: [refusalText(outcome.refusal)] };
  return { repository: entry.repository, branch: entry.branch, path: entry.path };
}

/** The session's folder is the umbrella the mirrored worktree serves, or that worktree. */
async function isSessionUmbrella(
  folder: string,
  umbrella: UmbrellaWorktreeResult,
): Promise<boolean> {
  const [session, ...served] = await Promise.all(
    [folder, umbrella.path, umbrella.worktree].map(canonicalPath),
  );
  return served.includes(session!);
}

/**
 * In an Umbrella Repository session: the branch of every child worktree in the mirrored
 * worktree, recorded per child.
 */
async function recordUmbrella(
  environment: DeliveryEnvironment,
  change: string,
  result: WorktreeResult,
  umbrella: UmbrellaWorktreeResult,
): Promise<RecordedBranch> {
  const children = result.repositories.filter((entry) =>
    umbrella.repositories.includes(entry.repository),
  );
  const recorded: string[] = [];
  const failed: string[] = [];
  for (const entry of children) {
    // oxlint-disable-next-line no-await-in-loop -- one Delivery Record, written in order
    const outcome = await recordDelivery(environment, {
      changes: [change],
      repository: entry.repository,
      edit: { delivery: { branch: entry.branch, direct: false } },
    });
    if ("refusal" in outcome) failed.push(`${entry.repository}: ${refusalText(outcome.refusal)}`);
    else recorded.push(entry.repository);
  }
  // The first child folder's in name order, as `currentBranch` reads the session's later.
  const branch = children.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0]
    ?.branch;
  return {
    handoff: `${umbrella.worktree} is a mirrored umbrella worktree, not a Git worktree`,
    path: umbrella.worktree,
    ...(branch ? { branch } : {}),
    repositories: recorded,
    ...(failed.length > 0 ? { failed } : {}),
  };
}

function refusalText(refusal: DeliveryRefusal): string {
  return refusal.reason === "unknown-change"
    ? `no active change ${refusal.change}`
    : sharedRefusalMessage(refusal);
}

/** Detected by the markers each runtime sets for the commands its agent runs. */
function enterInstruction(
  env: Record<string, string | undefined>,
  recorded: RecordedBranch,
): EnterInstruction {
  const runtime = runtimeOf(env);
  if ("skipped" in recorded) return { runtime, action: "handoff", reason: recorded.skipped };
  // Before `failed`: a mirrored worktree stays the place to work on when a record failed.
  if ("handoff" in recorded) {
    // Claude's `EnterWorktree` takes only Git worktrees; `mate_enter_worktree` takes this folder.
    if (runtime === "opencode") {
      return { runtime, action: "tool", tool: ENTER_TOOLS.opencode, path: recorded.path };
    }
    return { runtime, action: "handoff", path: recorded.path, reason: recorded.handoff };
  }
  if ("failed" in recorded) {
    const reason = `recording the delivery branch failed: ${recorded.failed.join("; ")}`;
    return { runtime, action: "handoff", reason };
  }
  const { path: target } = recorded;
  if (runtime === "unknown") {
    const reason = "this Agent Runtime cannot move a running session";
    return { runtime, action: "handoff", path: target, reason };
  }
  return { runtime, action: "tool", tool: ENTER_TOOLS[runtime], path: target };
}

const ENTER_TOOLS = {
  claude: "EnterWorktree",
  opencode: "mate_enter_worktree",
} as const satisfies Record<string, NonNullable<EnterInstruction["tool"]>>;

function runtimeOf(env: Record<string, string | undefined>): EnterInstruction["runtime"] {
  if (env.CLAUDECODE === "1") return "claude";
  if (env.OPENCODE_SESSION_ID) return "opencode";
  return "unknown";
}

function enterLine(enter: EnterInstruction): string {
  if (enter.action === "tool") return `${n}: enter: call ${enter.tool} with ${enter.path}`;
  if (enter.path) return `${n}: enter: start a new session in ${enter.path} (${enter.reason})`;
  return `${n}: enter: not entering (${enter.reason})`;
}

function printEnter(enter: EnterInstruction): void {
  process.stdout.write(`${enterLine(enter)}\n`);
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
      const { wrap } = entry;
      if (wrap.outcome === "ok") {
        process.stdout.write(`${prefix} wrapped for ${wrap.runtimes.join(", ")}\n`);
      } else if (wrap.outcome === "skipped") {
        process.stdout.write(`${prefix} wrap skipped (${wrap.reason})\n`);
      }
      const { command, outcome, reason } = entry.install;
      process.stdout.write(
        outcome === "skipped"
          ? `${prefix} install skipped (${reason})\n`
          : `${prefix} install ${command} ${outcome}\n`,
      );
      const { index } = entry;
      process.stdout.write(
        `${prefix} tokensave index ${index.outcome}${index.reason ? ` (${index.reason})` : ""}\n`,
      );
      if (entry.missingEnv.length > 0) {
        process.stdout.write(
          `${prefix} env files missing in the worktree (not copied): ${entry.missingEnv.join(", ")}\n`,
        );
      }
    }
    if (entry.error) console.error(`${n} working worktree: ${entry.repository}: ${entry.error}`);
  }
  const { umbrella } = result;
  if (!umbrella) return;
  const prefix = `${n}: ${umbrella.path}:`;
  process.stdout.write(`${prefix} ${umbrella.action} mirrored worktree ${umbrella.worktree}\n`);
  const { wrap } = umbrella;
  if (wrap.outcome === "ok") {
    process.stdout.write(`${prefix} wrapped for ${wrap.runtimes.join(", ")}\n`);
  } else if (wrap.outcome === "skipped") {
    process.stdout.write(`${prefix} wrap skipped (${wrap.reason})\n`);
  }
  const { index } = umbrella;
  process.stdout.write(
    `${prefix} tokensave index ${index.outcome}${index.reason ? ` (${index.reason})` : ""}\n`,
  );
  if (umbrella.error) console.error(`${n} working worktree: ${umbrella.path}: ${umbrella.error}`);
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
  for (const entry of result.umbrellas?.removed ?? []) {
    process.stdout.write(`${n}: removed mirrored worktree ${entry.path} (${entry.workset})\n`);
  }
  for (const entry of result.umbrellas?.kept ?? []) {
    process.stdout.write(
      `${n}: kept mirrored worktree ${entry.path} (${entry.workset}): ${entry.reason}\n`,
    );
  }
  if (result.removed.length === 0 && result.kept.length === 0 && !result.umbrellas) {
    process.stdout.write(`${n}: no worktree of a Done Workset to prune\n`);
  }
}

/**
 * `mate working worktree <workset-id>` creates or reuses the Workset's worktree in each
 * Working Repository; `--change <change>` does so for the Workset the change resolves to,
 * and with `--enter` also records the current repository's branch as the change's delivery
 * and reports how the Agent Runtime enters the worktree; `mate working worktree prune`
 * removes those of Done Worksets.
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
        .map(({ record }) => ({ id: record.id, changes: record.changes }));
      const result = await (deps.prune ?? pruneWorksetWorktrees)(companion, done);
      reportProblems([], result.warnings);
      if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else printPruned(result);
      return;
    }
    let ticket: string | undefined;
    if (parsed.ticket !== undefined) {
      if (!isJiraKey(parsed.ticket)) {
        console.error(`${n} working worktree: --ticket expects a Jira key such as ABC-123.`);
        process.exitCode = 1;
        return;
      }
      if ((await (deps.ticketFormat ?? companionTicketFormat)(companion)) !== "jira") {
        console.error(`${n} working worktree: ${TICKETS_OFF}`);
        process.exitCode = 1;
        return;
      }
      ticket = normalizeJiraKey(parsed.ticket);
    }
    const options = {
      install: parsed.install,
      streamInstall: !parsed.json,
      ...(ticket ? { ticket } : {}),
    };
    const result =
      "change" in parsed
        ? await (deps.createForChange ?? createChangeWorktrees)(companion, parsed.change, options)
        : await (deps.create ?? createWorksetWorktrees)(companion, parsed.target, options);
    // Only a successful creation records a branch and says how to enter; a failed
    // recording leaves the worktrees usable, so it hands off instead of failing.
    let enter: EnterInstruction | undefined;
    if ("change" in parsed && parsed.enter && result.ok) {
      const record = deps.recordBranch ?? recordBranch;
      const recorded = await record(companion, parsed.change, result, deps.cwd ?? process.cwd());
      if ("failed" in recorded) result.warnings.push(...(recorded.failed ?? []));
      enter = enterInstruction(deps.env ?? process.env, recorded);
      // A handed-off umbrella session stays where it is; its successor registers the branch.
      const handedOff = "handoff" in recorded && enter.action !== "tool";
      const move =
        "branch" in recorded && recorded.branch && !handedOff
          ? { cwd: recorded.path, branch: recorded.branch }
          : undefined;
      await (deps.attribute ?? attributeCurrentSession)(
        { change: parsed.change, ...(move ? { move } : {}) },
        deps.env ?? process.env,
      );
    }
    reportProblems(result.diagnostics, result.warnings);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(enter ? { ...result, enter } : result, null, 2)}\n`);
    } else {
      printCreated(result);
      if (enter) printEnter(enter);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`${n} working worktree: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
