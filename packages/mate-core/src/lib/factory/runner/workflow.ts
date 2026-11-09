import fs from "node:fs/promises";
import path from "node:path";

import { activeChanges, changesDirOf } from "../../change-layout";
import { declaredDependencies } from "../../delivery/overlap";
import { findDelivery, readDeliveryRecord, sameRepository } from "../../delivery/record";
import { scopedRepositories } from "../../openspec-scopes";
import {
  advanceWorkset,
  findWorkset,
  type WorksetRecord,
  writeWorkset,
} from "../../workset/record";
import type { CommandResult } from "../command";
import { repoKey } from "../ids";
import { readWorktreeBranch } from "../worktree-branch";
import type { MemorySize } from "../runtime";
import type { TurnEvent } from "./live";
import type { AgentQuestion, RunStage } from "./state";

/**
 * The agent stages of one Workset, run unattended. Prompts are fixed here; the only
 * text from a person is an answer to the agent's own question. People keep the
 * triggers: apply and publish start only on request, and no review approval is
 * recorded anywhere.
 */

export type { AgentQuestion } from "./state";

/** A turn ends done, or on questions a person answers together. */
export type TurnOutcome = { kind: "done" } | { kind: "question"; questions: AgentQuestion[] };

/** One agent turn in the Workset's conversation, continued from the previous one. */
export interface StageAgent {
  turn(request: {
    worksetId: string;
    /** The stage the turn belongs to, which sizes the Workset's container. */
    stage?: RunStage;
    prompt: string;
    signal: AbortSignal;
    /** The turn's text, whole blocks; `streamed` when `onEvent` already showed it. */
    onText: (text: string, streamed?: boolean) => void;
    /** The turn's text as it streams and its tool calls, for people following the run. */
    onEvent?: (event: TurnEvent) => void;
    /** Extra environment for this turn's agent and its commands only. */
    env?: Record<string, string>;
  }): Promise<TurnOutcome>;
}

export type StageOutcome = TurnOutcome;

export class StageError extends Error {}

export interface WorkflowDeps {
  companionPath: string;
  /** `/var/lib/mate-factory`, where the appliance's clones live. */
  stateDir: string;
  agent: StageAgent;
  /** The stage being run, handed to each of its turns. */
  stage?: RunStage;
  /** Runs as the unprivileged user in the appliance: `git` and `mate`. */
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  /** Appends to the run log; `streamed` text reached live viewers already. */
  log: (text: string, streamed?: boolean) => void;
  /** Live turn events for people following the run; never stored. */
  onEvent?: (event: TurnEvent) => void;
  signal: AbortSignal;
  /** Told the branch once it reached the remote, for the card's compare link. */
  onPushed?: (branch: string) => void | Promise<void>;
  /** Takes a review report file a show-me turn produced, and stores it for the change. */
  storeReport?: (change: string, file: string) => Promise<void>;
}

/** Starts the first factory turn after a person worked in the conversation directly. */
export const RETURN_NOTE =
  "A person worked in this conversation directly; check the current state before continuing.";
/** The row shows what the agent last reported; without it, only a sentence derived from the stage. */
const REPORT = "Before you end, report the situation for the person with report_situation.";

export const PROMPTS = {
  clarify: (record: Pick<WorksetRecord, "title" | "intent">) =>
    [
      `/mate-clarify-intent ${record.title}${record.intent.trim() ? `: ${record.intent.trim()}` : ""}`,
      REPORT,
    ].join("\n"),
  explore: (record: Pick<WorksetRecord, "id" | "title">) =>
    [
      `/mate-explore-change Explore Workset ${record.id} (${record.title}) from the PRE-EXPLORE HANDOFF above.`,
      "Write no files.",
      "End with the agreed direction and the slices, in dependency order.",
      REPORT,
    ].join("\n"),
  // A Workset can reach Ready without a session, so the record's intent is always named.
  propose: (record: Pick<WorksetRecord, "id" | "title" | "intent">) =>
    [
      `/mate-propose-change Propose Workset ${record.id} (${record.title}), one change per slice.`,
      record.intent.trim() ? `Intent: ${record.intent.trim()}` : "The Workset records no intent.",
      "Use the slices agreed in this conversation when there is one; otherwise slice the intent yourself.",
      REPORT,
    ].join("\n"),
  // The prompt names the file too, in case a harness drops the turn's environment.
  review: (change: string, file: string) =>
    [
      `/mate-show-me ${change}`,
      `Deliver the report with MATE_REPORT_OUTPUT=${file} mate report --input <your JSON file>.`,
    ].join("\n"),
  revise: (changes: string[], comment: string) =>
    [
      `/mate-propose-change Revise ${changes.join(", ")} with this feedback:`,
      comment.trim(),
      REPORT,
    ].join("\n"),
  // The Outcome's changes are archived, so the feedback becomes a change of its own.
  followUp: (record: Pick<WorksetRecord, "id" | "title">, feedback: string) =>
    [
      `/mate-propose-change Propose one follow-up change for Workset ${record.id} (${record.title}), delivered with its earlier changes, for this feedback:`,
      feedback.trim(),
      REPORT,
    ].join("\n"),
  apply: (change: string) => [`/mate-apply-change ${change}`, REPORT].join("\n"),
  archive: (change: string) => `/mate-archive-change ${change}`,
};

async function recordOf(companionPath: string, id: string): Promise<WorksetRecord> {
  const record = await findWorkset(companionPath, id);
  if (!record) throw new StageError(`Workset ${id} has no valid record`);
  if (record.repositories.length !== 1) {
    throw new StageError(
      `Workset ${id} names ${record.repositories.length} repositories; runs need one`,
    );
  }
  return record;
}

function changeDir(companionPath: string, change: string): string {
  return path.join(changesDirOf(companionPath), change);
}

/** The result, unless the command failed; then a StageError with its output. */
function check(result: CommandResult, action: string): CommandResult {
  if (result.status !== 0)
    throw new StageError(`${action} failed: ${(result.stderr || result.stdout).trim()}`);
  return result;
}

async function turn(
  deps: WorkflowDeps,
  id: string,
  prompt: string,
  env?: Record<string, string>,
): Promise<TurnOutcome> {
  deps.log(`\n> ${prompt}\n`);
  return deps.agent.turn({
    worksetId: id,
    ...(deps.stage ? { stage: deps.stage } : {}),
    prompt,
    signal: deps.signal,
    onText: deps.log,
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    ...(env ? { env } : {}),
  });
}

/** Unchecked and checked task boxes in a change's `tasks.md`. */
export async function taskCounts(dir: string): Promise<{ open: number; done: number }> {
  const text = await fs.readFile(path.join(dir, "tasks.md"), "utf8").catch(() => "");
  return {
    open: (text.match(/^\s*- \[ \]/gm) ?? []).length,
    done: (text.match(/^\s*- \[[xX]\]/gm) ?? []).length,
  };
}

/** Linked changes, dependencies first; a dependency outside the Workset does not order. */
export async function inDependencyOrder(
  companionPath: string,
  changes: string[],
): Promise<string[]> {
  const linked = new Set(changes);
  const deps = new Map(
    await Promise.all(
      changes.map(
        async (change) =>
          [
            change,
            (await declaredDependencies(changeDir(companionPath, change))).filter((name) =>
              linked.has(name),
            ),
          ] as const,
      ),
    ),
  );
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (change: string) => {
    if (ordered.includes(change)) return;
    if (visiting.has(change))
      throw new StageError(`changes ${[...visiting].join(", ")} depend on each other`);
    visiting.add(change);
    for (const dependency of deps.get(change) ?? []) visit(dependency);
    visiting.delete(change);
    ordered.push(change);
  };
  for (const change of changes) visit(change);
  return ordered;
}

/**
 * One pre-propose stage: its prompt (or the person's answer) as a turn, then the record
 * advances, so pickup queues the next stage in the same conversation.
 */
async function planningStage(
  deps: WorkflowDeps,
  id: string,
  expected: WorksetRecord["stage"],
  prompt: (record: WorksetRecord) => string,
  answer?: string,
): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  if (record.changes.length > 0 || record.stage !== expected) {
    throw new StageError(`Workset ${id} is no longer at ${expected}`);
  }
  const outcome = await turn(deps, id, answer ?? prompt(record));
  if (outcome.kind === "question") return outcome;
  const advanced = await advanceWorkset(deps.companionPath, id);
  deps.log(`\n${id} is now at ${advanced.stage}\n`);
  return { kind: "done" };
}

/** Clarify intent; the skill itself decides whether to interview, grill or skip. */
export function clarifyStage(deps: WorkflowDeps, id: string, answer?: string) {
  return planningStage(deps, id, "clarify-intent", PROMPTS.clarify, answer);
}

/** Explore change from the handoff; it writes nothing. */
export function exploreStage(deps: WorkflowDeps, id: string, answer?: string) {
  return planningStage(deps, id, "explore", PROMPTS.explore, answer);
}

/** Propose, then link the changes it created for the Workset's repository. */
export async function proposeStage(
  deps: WorkflowDeps,
  id: string,
  answer?: string,
): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  const before = new Set(await activeChanges(deps.companionPath));
  // An answer continues the propose turn that asked, so what it creates counts as proposed.
  const outcome = await turn(deps, id, answer ?? PROMPTS.propose(record));
  if (outcome.kind === "question") return outcome;

  const ours = await linkCreatedChanges(deps, id, before);
  if (ours.length === 0) {
    throw new StageError(`propose created no change for ${record.repositories[0]!}`);
  }
  return reviewReports(deps, id, ours);
}

/**
 * Links the active changes created since `before` that are scoped to the Workset's
 * repository, once each; returns them.
 */
export async function linkCreatedChanges(
  deps: Pick<WorkflowDeps, "companionPath" | "log">,
  id: string,
  before: ReadonlySet<string>,
): Promise<string[]> {
  const repository = (await recordOf(deps.companionPath, id)).repositories[0]!;
  const created = (await activeChanges(deps.companionPath)).filter((change) => !before.has(change));
  const scoped = await Promise.all(
    created.map(async (change) => ({
      change,
      scopes: await scopedRepositories(changeDir(deps.companionPath, change)),
    })),
  );
  const ours = scoped.flatMap(({ change, scopes }) =>
    scopes.some((scope) => sameRepository(scope, repository)) ? [change] : [],
  );
  if (ours.length === 0) return [];
  const latest = await recordOf(deps.companionPath, id);
  const linked = new Set(latest.changes);
  const fresh = ours.filter((change) => !linked.has(change));
  if (fresh.length === 0) return [];
  await writeWorkset(deps.companionPath, { ...latest, changes: [...latest.changes, ...fresh] });
  deps.log(`\nlinked ${fresh.join(", ")} to ${id}\n`);
  return fresh;
}

/** Where a show-me turn writes a change's report: the clone's git directory, outside any work tree. */
function reviewReportFile(
  stateDir: string,
  repository: string,
  id: string,
  change: string,
): string {
  return path.join(
    stateDir,
    "repos",
    repoKey(repository),
    ".git",
    "mate-factory",
    "reports",
    id,
    `${change}.html`,
  );
}

/**
 * One show-me turn per change, each saving its report for Studio. A report is a help for
 * the review, not part of the plan, so a failure is logged and the stage goes on.
 */
export async function reviewReports(
  deps: WorkflowDeps,
  id: string,
  changes: string[],
): Promise<StageOutcome & { kind: "done" }> {
  const record = await recordOf(deps.companionPath, id);
  const repository = record.repositories[0]!;
  for (const change of changes) {
    const file = reviewReportFile(deps.stateDir, repository, id, change);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one conversation: turns run in order
      const outcome = await turn(deps, id, PROMPTS.review(change, file), {
        MATE_REPORT_OUTPUT: file,
      });
      // A report needs no decision; a question here would strand the stage that ran it.
      if (outcome.kind === "question") {
        deps.log(
          `\nthe review report for ${change} asked instead: ${outcome.questions.map((asked) => asked.question).join(" / ")}\n`,
        );
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- reports are stored in the turns' order
      const produced = await fs.stat(file).then(
        () => true,
        () => false,
      );
      if (!produced) deps.log(`\nno review report was produced for ${change}\n`);
      // oxlint-disable-next-line no-await-in-loop -- reports are stored in the turns' order
      else await deps.storeReport?.(change, file);
    } catch (error) {
      if (deps.signal.aborted) throw error;
      deps.log(`\nthe review report for ${change} failed: ${(error as Error).message}\n`);
    }
  }
  return { kind: "done" };
}

async function activeLinked(deps: WorkflowDeps, record: WorksetRecord): Promise<string[]> {
  const active = new Set(await activeChanges(deps.companionPath));
  return record.changes.filter((change) => active.has(change));
}

/**
 * A person's feedback, sent to propose's revise mode, then fresh reports. An answer continues
 * the revise turn that asked instead. Without either it only regenerates the reports. When
 * every change is already being applied, the person approved the plan before, so apply
 * continues on the same branch; a change still waiting for review keeps the whole Outcome at
 * review.
 */
export async function reviseStage(
  deps: WorkflowDeps,
  id: string,
  answer?: string,
  feedback?: string,
): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  const changes = await activeLinked(deps, record);
  if (changes.length === 0) throw new StageError(`Workset ${id} has no active change to revise`);
  const prompt = answer ?? (feedback?.trim() ? PROMPTS.revise(changes, feedback) : undefined);
  if (prompt === undefined) return reviewReports(deps, id, changes);
  const building = (
    await Promise.all(
      changes.map(async (change) => (await taskCounts(changeDir(deps.companionPath, change))).done),
    )
  ).every((done) => done > 0);
  const outcome = await turn(deps, id, prompt);
  if (outcome.kind === "question") return outcome;
  await reviewReports(deps, id, changes);
  return building ? applyStage(deps, id) : { kind: "done" };
}

/** The commit message for a change's work, with a `Workset:` trailer naming the Workset. */
export function applyMessage(changes: string[], id: string): string {
  return `Apply ${changes.join(", ")}\n\nWorkset: ${id}`;
}

/**
 * Commits whatever the agent left in the worktree; the apply skill never commits, so
 * without this the push would carry none of the work. Nothing staged is no commit.
 * The author is the factory's, set in the runner's environment.
 */
async function commitWork(deps: WorkflowDeps, id: string, message: string): Promise<void> {
  const worktree = path.join(deps.stateDir, "worktrees", id);
  const git = (...args: string[]) => deps.run("git", ["-C", worktree, ...args], deps.companionPath);
  check(await git("add", "--all"), `staging ${id}'s work`);
  if ((await git("diff", "--cached", "--quiet")).status === 0) return;
  check(await git("commit", "--quiet", "-m", message), `committing ${id}'s work`);
  deps.log(`\ncommitted: ${message.split("\n")[0]}\n`);
}

/**
 * Apply linked changes on the actual worktree branch, committing each,
 * push that branch from the appliance, then archive each change. Repeating it after an answer or a
 * retry skips what is already done.
 */
export async function applyStage(
  deps: WorkflowDeps,
  id: string,
  answer?: string,
): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  const repository = record.repositories[0]!;
  const worktree = path.join(deps.stateDir, "worktrees", id);
  const currentBranch = () =>
    readWorktreeBranch(worktree, (args) => deps.run("git", args, deps.companionPath));
  const branch = await currentBranch();
  const assertBranch = async () => {
    if ((await currentBranch()) !== branch) {
      throw new StageError(
        `Worktree ${id} changed branches during apply; repair delivery explicitly before pushing ${branch}.`,
      );
    }
  };
  const active = new Set(await activeChanges(deps.companionPath));
  let pending = (await inDependencyOrder(deps.companionPath, record.changes)).filter((change) =>
    active.has(change),
  );
  const linked = new Set<string>();
  await Promise.all(
    pending.map(async (change) => {
      const delivery = await readDeliveryRecord(changeDir(deps.companionPath, change));
      const recorded = delivery ? findDelivery(delivery, repository) : undefined;
      if (recorded && (recorded.notApplicable || recorded.branch !== branch)) {
        throw new StageError(
          `Change ${change} records ${recorded.branch ?? "not-applicable"}, but worktree ${id} uses ${branch}; confirm an explicit relink or repair the worktree before apply.`,
        );
      }
      if (recorded) linked.add(change);
    }),
  );
  // An answer continues the turn that asked; the loop then picks up what is still open.
  if (answer !== undefined) {
    const answered = await turn(deps, id, answer);
    if (answered.kind === "question") return answered;
    await assertBranch();
    const stillActive = new Set(await activeChanges(deps.companionPath));
    pending = pending.filter((change) => stillActive.has(change));
  }

  for (const change of pending) {
    // oxlint-disable-next-line no-await-in-loop -- applies run in dependency order, one conversation
    const counts = await taskCounts(changeDir(deps.companionPath, change));
    if (counts.open === 0 && counts.done > 0) continue;
    if (!linked.has(change))
      check(
        await deps.run(
          "mate",
          ["artifact", "link", change, "--repository", repository, "--branch", branch, "--json"],
          deps.companionPath,
        ),
        `recording ${branch} for ${change}`,
      );
    const outcome = await turn(deps, id, PROMPTS.apply(change));
    if (outcome.kind === "question") return outcome;
    // oxlint-disable-next-line no-await-in-loop -- verify each turn before committing its work
    await assertBranch();
    // A change with open tasks stays uncommitted; the check below stops the run.
    // oxlint-disable-next-line no-await-in-loop -- each change is its own commit, in order
    const after = await taskCounts(changeDir(deps.companionPath, change));
    if (after.open === 0)
      // oxlint-disable-next-line no-await-in-loop -- each change is its own commit, in order
      await commitWork(deps, id, applyMessage([change], id));
  }

  const unfinished = (
    await Promise.all(
      pending.map(async (change) => ({
        change,
        open: (await taskCounts(changeDir(deps.companionPath, change))).open,
      })),
    )
  ).flatMap(({ change, open }) => (open > 0 ? [`${change} (${open} open)`] : []));
  if (unfinished.length > 0) throw new StageError(`tasks are still open: ${unfinished.join(", ")}`);

  if (pending.length > 0) {
    // Work an earlier run left uncommitted, for example before a restart.
    await assertBranch();
    await commitWork(deps, id, applyMessage(pending, id));
    const clone = path.join(deps.stateDir, "repos", repoKey(repository));
    check(
      await deps.run(
        "git",
        ["-C", clone, "push", "--end-of-options", "origin", branch],
        deps.companionPath,
      ),
      `pushing ${branch}`,
    );
    deps.log(`\npushed ${branch}\n`);
    await deps.onPushed?.(branch);
  }

  for (const change of pending) {
    // oxlint-disable-next-line no-await-in-loop -- one conversation: turns run in order
    const outcome = await turn(deps, id, PROMPTS.archive(change));
    if (outcome.kind === "question") return outcome;
  }
  return { kind: "done" };
}

/** Publication, which a person's Publish request confirms; the publish command still checks the merge. */
export async function publishStage(deps: WorkflowDeps, id: string): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  const active = new Set(await activeChanges(deps.companionPath));
  const archived = record.changes.filter((name) => !active.has(name));
  for (const change of archived) {
    // oxlint-disable-next-line no-await-in-loop -- publications commit and tag one at a time, in the Workset's order
    const published = await deps.run(
      "mate",
      ["artifact", "publish", change, "--json"],
      deps.companionPath,
    );
    check(published, `publishing ${change}`);
    deps.log(`\npublished ${change}\n`);
  }
  return { kind: "done" };
}

/** Stages that install, build and test, run at the build size and under the build cap. */
export const BUILD_STAGES: ReadonlySet<RunStage> = new Set<RunStage>(["apply"]);

/** The container size a stage's turns need; a turn without a stage gets the build size. */
export function memorySizeFor(stage: RunStage | undefined): MemorySize {
  return stage === undefined || BUILD_STAGES.has(stage) ? "build" : "agent";
}

export const STAGES: Record<
  Exclude<RunStage, "archive">,
  (deps: WorkflowDeps, id: string, answer?: string, feedback?: string) => Promise<StageOutcome>
> = {
  clarify: clarifyStage,
  explore: exploreStage,
  propose: proposeStage,
  revise: reviseStage,
  apply: applyStage,
  publish: publishStage,
};
