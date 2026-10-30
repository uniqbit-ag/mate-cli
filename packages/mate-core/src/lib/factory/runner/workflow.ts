import fs from "node:fs/promises";
import path from "node:path";

import { activeChanges, changesDirOf } from "../../change-layout";
import { declaredDependencies } from "../../delivery/overlap";
import { sameRepository } from "../../delivery/record";
import { scopedRepositories } from "../../openspec-scopes";
import { readWorksets, type WorksetRecord, writeWorkset } from "../../workset/record";
import type { CommandResult } from "../command";
import { deliveryBranch, repoKey } from "../ids";
import type { RunStage } from "./state";

/**
 * The agent stages of one Workset, run unattended. Prompts are fixed here; the only
 * text from a person is an answer to the agent's own question. People keep the
 * triggers: apply and publish start only on request, and no review approval is
 * recorded anywhere.
 */

export type TurnOutcome = { kind: "done" } | { kind: "question"; question: string };

/** One agent turn in the Workset's conversation, continued from the previous one. */
export interface StageAgent {
  turn(request: {
    worksetId: string;
    prompt: string;
    signal: AbortSignal;
    onText: (text: string) => void;
  }): Promise<TurnOutcome>;
}

export type StageOutcome = TurnOutcome;

export class StageError extends Error {}

export interface WorkflowDeps {
  companionPath: string;
  /** `/var/lib/mate-factory`, where the appliance's clones live. */
  stateDir: string;
  agent: StageAgent;
  /** Runs as the unprivileged user in the appliance: `git` and `mate`. */
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  log: (text: string) => void;
  signal: AbortSignal;
  /** Told the branch once it reached the remote, for the card's compare link. */
  onPushed?: (branch: string) => void | Promise<void>;
}

export const PROMPTS = {
  // A Workset can reach Ready without a session, so the record's intent is always named.
  propose: (record: Pick<WorksetRecord, "id" | "title" | "intent">) =>
    [
      `/mate-propose-change Propose Workset ${record.id} (${record.title}), one change per slice.`,
      record.intent.trim() ? `Intent: ${record.intent.trim()}` : "The Workset records no intent.",
      "Use the slices agreed in this conversation when there is one; otherwise slice the intent yourself.",
      "Ask with ask_human only what a person must decide.",
    ].join("\n"),
  apply: (change: string) => `/mate-apply-change ${change}`,
  archive: (change: string) => `/mate-archive-change ${change}`,
};

async function recordOf(companionPath: string, id: string): Promise<WorksetRecord> {
  const record = (await readWorksets(companionPath)).worksets.find((entry) => entry.id === id);
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

async function turn(deps: WorkflowDeps, id: string, prompt: string): Promise<TurnOutcome> {
  deps.log(`\n> ${prompt}\n`);
  return deps.agent.turn({ worksetId: id, prompt, signal: deps.signal, onText: deps.log });
}

/** Unchecked and checked task boxes in a change's `tasks.md`. */
export async function taskCounts(changeDir: string): Promise<{ open: number; done: number }> {
  const text = await fs.readFile(path.join(changeDir, "tasks.md"), "utf8").catch(() => "");
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

  const repository = record.repositories[0]!;
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
  if (ours.length === 0) throw new StageError(`propose created no change for ${repository}`);
  const latest = await recordOf(deps.companionPath, id);
  await writeWorkset(deps.companionPath, {
    ...latest,
    changes: [...new Set([...latest.changes, ...ours])],
  });
  deps.log(`\nlinked ${ours.join(", ")} to ${id}\n`);
  return { kind: "done" };
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
 * Apply every linked change in dependency order on `change/<workset>`, committing each,
 * push that branch from the appliance, then archive each change. Repeating it after an answer or a
 * retry skips what is already done.
 */
export async function applyStage(
  deps: WorkflowDeps,
  id: string,
  answer?: string,
): Promise<StageOutcome> {
  const record = await recordOf(deps.companionPath, id);
  // An answer continues the turn that asked; the loop then picks up what is still open.
  if (answer !== undefined) {
    const answered = await turn(deps, id, answer);
    if (answered.kind === "question") return answered;
  }
  const repository = record.repositories[0]!;
  const branch = deliveryBranch(id);
  const active = new Set(await activeChanges(deps.companionPath));
  const pending = (await inDependencyOrder(deps.companionPath, record.changes)).filter((change) =>
    active.has(change),
  );

  for (const change of pending) {
    // oxlint-disable-next-line no-await-in-loop -- applies run in dependency order, one conversation
    const counts = await taskCounts(changeDir(deps.companionPath, change));
    if (counts.open === 0 && counts.done > 0) continue;
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
    await commitWork(deps, id, applyMessage(pending, id));
    const clone = path.join(deps.stateDir, "repos", repoKey(repository));
    check(
      await deps.run("git", ["-C", clone, "push", "origin", branch], deps.companionPath),
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
  // Publications commit and tag one at a time, in the Workset's order.
  await archived.reduce(async (previous, change) => {
    await previous;
    check(
      await deps.run("mate", ["artifact", "publish", change, "--json"], deps.companionPath),
      `publishing ${change}`,
    );
    deps.log(`\npublished ${change}\n`);
  }, Promise.resolve());
  return { kind: "done" };
}

export const STAGES: Record<
  Exclude<RunStage, "archive">,
  (deps: WorkflowDeps, id: string, answer?: string) => Promise<StageOutcome>
> = {
  propose: proposeStage,
  apply: applyStage,
  publish: publishStage,
};
