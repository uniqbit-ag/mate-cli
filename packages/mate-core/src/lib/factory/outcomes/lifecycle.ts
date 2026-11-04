import fs from "node:fs/promises";

import type { FactoryClient } from "../client";
import { FactoryError } from "../ids";
import { compareRanked, rankOf } from "../runner/rank";
import { type FactoryRunner, pickableStage } from "../runner/scheduler";
import type { Run } from "../runner/run";
import { StageError } from "../runner/workflow";
import { readWorksets } from "../../workset/record";
import type { WorksetWithStage } from "../../workset/stages";
import { NO_CREDENTIAL } from "../credential-store";

/** The steps of an Outcome's lifecycle the Factory Outcomes module runs: pickup, reclaim, reports. */

export const FACTORY_STATE_DIR_ENV = "MATE_FACTORY_STATE_DIR";
const FACTORY_MAX_RUNS_ENV = "MATE_FACTORY_MAX_RUNS";
const FACTORY_MAX_BUILDS_ENV = "MATE_FACTORY_PARALLEL_BUILDS";
const FACTORY_STAGE_MINUTES_ENV = "MATE_FACTORY_STAGE_MINUTES";
const FACTORY_GIT_NAME_ENV = "MATE_FACTORY_GIT_NAME";
const FACTORY_GIT_EMAIL_ENV = "MATE_FACTORY_GIT_EMAIL";
/** The author of every commit the factory makes, unless the operator names another. */
const FACTORY_GIT_AUTHOR = { name: "Mate factory", email: "factory@mate.invalid" };

/**
 * Git's author and committer for the runner's commands: the factory's own identity,
 * whatever Git is configured with, so `git log` tells factory commits apart.
 */
export function factoryGitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const name = env[FACTORY_GIT_NAME_ENV]?.trim() || FACTORY_GIT_AUTHOR.name;
  const email = env[FACTORY_GIT_EMAIL_ENV]?.trim() || FACTORY_GIT_AUTHOR.email;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export const DEFAULT_STATE_DIR = "/var/lib/mate-factory";
/** The unprivileged user's home inside Workset containers. */
export const WORKSET_HOME = "/home/mate";

/** The runner and Runs for one companion. */
export interface RunnerParts {
  runner: FactoryRunner;
  runs: Run;
  companionPath: string;
}

/** Where review reports go, already bound to the served companion. */
export interface ReviewReportStore {
  publish(report: { title: string; html: string }): Promise<{ id: string }>;
  /** Ids of the reports the store still keeps. */
  ids(): Promise<string[]>;
}

/** The Worksets whose changes are all Done, by the stages the board derives. */
export function doneWorksetsFrom(
  readStages: () => Promise<{ worksets: WorksetWithStage[] }>,
): () => Promise<string[]> {
  return async () => {
    const { worksets } = await readStages();
    return worksets.flatMap(({ record, derived }) => (derived.stage === "done" ? [record.id] : []));
  };
}

export interface ReclaimDeps {
  client: Pick<FactoryClient, "list" | "delete">;
  runs: Run;
  runner: Pick<FactoryRunner, "isActive">;
  doneWorksets: () => Promise<string[]>;
  busy?: () => ReadonlySet<string>;
  /** Refused removals, retried only after the next publication. */
  refused: Set<string>;
}

/**
 * Removes each Done Workset's container, worktree and run files through the broker. Its
 * branches and record stay. A removal the broker refuses, such as for unpushed work, leaves
 * everything and becomes the Workset's situation. `settled` names the Workset whose run just
 * ended: when that was its publication, earlier refusals are tried again.
 */
export async function reclaimDone(deps: ReclaimDeps, settled?: string): Promise<string[]> {
  const done = await deps.doneWorksets();
  if (settled !== undefined && done.includes(settled)) deps.refused.clear();
  if (done.length === 0) return [];
  const held = new Set((await deps.client.list()).map((workset) => workset.id));
  const busy = deps.busy?.() ?? new Set<string>();
  const reclaimed: string[] = [];
  for (const id of done) {
    if (!held.has(id) || busy.has(id) || deps.runner.isActive(id) || deps.refused.has(id)) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one removal at a time through the broker
      await deps.client.delete(id);
      // oxlint-disable-next-line no-await-in-loop
      await deps.runs.forget(id);
      reclaimed.push(id);
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      deps.refused.add(id);
      // oxlint-disable-next-line no-await-in-loop
      await deps.runs.recordSituation(
        id,
        {
          text: `Done, but its container and worktree were kept: ${error.message}`,
        },
        "publish",
      );
    }
  }
  return reclaimed;
}

/**
 * Moves a review report a show-me turn left in the clone's git directory into Studio's
 * report store, and remembers its id for the change.
 */
export async function storeReviewReport(
  runs: Run,
  reports: ReviewReportStore,
  id: string,
  change: string,
  file: string,
): Promise<void> {
  const html = await fs.readFile(file, "utf8");
  const stored = await reports.publish({ title: `Review ${change}`, html });
  await runs.rememberReview(id, change, stored.id);
  await fs.rm(file, { force: true });
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** The runner's limits from startup's environment; the build cap defaults to every run. */
export function runnerLimits(env: NodeJS.ProcessEnv): {
  maxRuns: number;
  maxBuilds: number;
  stageMs: number;
} {
  const maxRuns = positive(env[FACTORY_MAX_RUNS_ENV], 2);
  return {
    maxRuns,
    maxBuilds: positive(env[FACTORY_MAX_BUILDS_ENV], maxRuns),
    stageMs: positive(env[FACTORY_STAGE_MINUTES_ENV], 60) * 60_000,
  };
}

export interface PickUpDeps {
  runner: FactoryRunner;
  companionPath: string;
  /** Worksets a person is working on in a session; never picked up. */
  busy?: () => ReadonlySet<string>;
}

/**
 * Requests the pickable stage of each started Outcome whose run is idle. Waiting, failed and
 * interrupted runs continue only through a person.
 */
export async function pickUpReady(deps: PickUpDeps): Promise<string[]> {
  const { worksets } = await readWorksets(deps.companionPath);
  const busy = deps.busy?.() ?? new Set<string>();
  const candidates = worksets
    .flatMap((record) => {
      const stage = pickableStage(record);
      if (!stage || busy.has(record.id) || deps.runner.isActive(record.id)) return [];
      return [{ id: record.id, stage, rank: rankOf(record) }];
    })
    .toSorted(compareRanked);
  // In rank order, one at a time: a request starts its run at once while a slot is free.
  const requested: string[] = [];
  for (const candidate of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- free slots go to the lowest rank first
      if (await deps.runner.pickUp(candidate.id, candidate.stage)) requested.push(candidate.id);
    } catch (error) {
      // Another request won the race; the Workset is running anyway.
      if (!(error instanceof StageError)) throw error;
    }
  }
  return requested;
}

/** Refuses a turn while the broker holds no agent credential, naming the Agents panel. */
export async function requireAgentCredential(client: Pick<FactoryClient, "info">): Promise<void> {
  if ((await client.info()).credential === null) throw new StageError(NO_CREDENTIAL);
}

/** Runs `task` one call at a time; a failure is logged as `what` failing, never thrown. */
export function serialized<A extends unknown[]>(
  what: string,
  task: (...args: A) => Promise<unknown>,
): (...args: A) => Promise<void> {
  let chain: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const run = () => task(...args);
    chain = chain.then(run, run).catch((error: unknown) => {
      process.stderr.write(`mate studio: ${what} failed: ${(error as Error).message}\n`);
    });
    return chain.then(() => undefined);
  };
}
