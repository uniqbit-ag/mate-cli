import path from "node:path";

import { activeChanges } from "../../change-layout";
import { companionTicketFormat, TICKETS_OFF } from "../../delivery/branches";
import {
  createOutcome,
  findWorkset,
  isWorksetId,
  readWorksets,
  removeWorkset,
  setWorksetStarted,
  WorksetError,
  writeWorkset,
} from "../../workset/record";
import { companionExecutorGuard } from "../../workset/execution";
import { dispatchPlan, materializeForFactory } from "./dispatch";
import { linkedRepositoryIdentities } from "../../workset/repositories";
import type { WorksetWithStage } from "../../workset/stages";
import { attachSocketFor, FACTORY_BROKER_ENV, type FactoryClient, factoryClient } from "../client";
import { runCommand } from "../command";
import { prepareWorkset } from "../prepare";
import { createHarnessStageAgent } from "../runner/harness-agent";
import type { LiveViewer } from "../runner/live";
import { rankOf } from "../runner/rank";
import { Run } from "../runner/run";
import { FactoryRunner } from "../runner/scheduler";
import { RunStore } from "../runner/state";
import { memorySizeFor, type StageAgent, StageError } from "../runner/workflow";
import {
  isOutcomeAction,
  type OutcomeAction,
  outcomeRefusal,
  type OutcomeRunFacts,
} from "./actions";
import {
  DEFAULT_STATE_DIR,
  doneWorksetsFrom,
  FACTORY_STATE_DIR_ENV,
  factoryGitEnv,
  pickUpReady,
  reclaimDone,
  requireAgentCredential,
  type ReviewReportStore,
  type RunnerParts,
  runnerLimits,
  serialized,
  storeReviewReport,
  WORKSET_HOME,
} from "./lifecycle";
import { type FactoryRunView, runViews } from "./runs";
import type { LiveSessions } from "./sessions";

export { type FactoryRunView, compareUrlFor } from "./runs";
export type { ReviewReportStore } from "./lifecycle";

/** The fields of a submitted board form; an absent field reads as an empty string. */
export type OutcomeFields = (name: string) => string;

/** Every Workset of the companion with its derived stage. */
export type WorksetStagesReader = () => Promise<{ worksets: WorksetWithStage[] }>;

/**
 * A companion's Outcomes: what a person may do to one, and how their runs read. Refuses
 * every action the Outcome action policy excludes.
 */
export interface Outcomes {
  readonly companionPath: string;
  /** The AFK runner drives these Outcomes; without it only Start and Later apply. */
  readonly automated: boolean;
  /** One board action; refused with a reason, changing nothing, when the Outcome does not accept it. */
  act(id: string, action: OutcomeAction, fields: OutcomeFields): Promise<void>;
  /** A new Outcome from the outcome input; with the runner, Start runs it at once. */
  create(fields: OutcomeFields): Promise<void>;
  /** Every Workset's run as the board shows it; `null` without the runner. */
  runs(): Promise<Record<string, FactoryRunView> | null>;
  /**
   * Start in local factory for an idea or an unapplied plan of own work: validated, then
   * queued in this checkout's scratchpad. Only the factory offers it.
   */
  dispatch?(
    id: string,
    mode: "propose-only" | "delivery",
    expected: { members: string[] },
  ): Promise<void>;
  /** Park proposal: a stopped, unapplied plan leaves the factory, keeping its claim. */
  park?(id: string): Promise<void>;
}

/**
 * A companion's Outcomes in factory mode. Owns the AFK runner, its run store, pickup and
 * reclaim.
 */
export interface FactoryOutcomes extends Outcomes {
  readonly automated: true;
  runs(): Promise<Record<string, FactoryRunView>>;
  /** A run's stored log. */
  log(id: string): Promise<string>;
  /** Follows a run's turns live. */
  watch(id: string): LiveViewer;
  /** Told whenever a run settles. */
  onChanged(listener: () => void): () => void;
  /** For a Workset session: the factory conversation a person continues, `null` while automatic. */
  takenOver(id: string): Promise<{ claudeSession: string | null } | null>;
  /**
   * Claude exited in a person's session: Return to automation, as the button does. Does
   * nothing unless the person has control; a failed return keeps it, with the reason recorded.
   */
  returnAfterExit(id: string): Promise<void>;
}

/** What the module asks of the server it runs in, given at construction. */
export interface OutcomesPorts {
  stages: WorksetStagesReader;
  reports: ReviewReportStore;
  sessions: LiveSessions;
}

/** The Work start guard as the Outcomes module uses it. */
export interface OutcomeGuard {
  /** `null` when this installation may start the Workset, else why not. */
  reserve(id: string): Promise<string | null>;
  /** `null` once nothing of this installation's start remains, else why not. */
  release(id: string): Promise<string | null>;
}

/** A built runner with the ports: the seam tests assemble the module from. */
export interface OutcomesParts extends RunnerParts, OutcomesPorts {
  client: Pick<FactoryClient, "list" | "delete">;
  /** Settles once stale runs are marked interrupted; every action waits for it. */
  ready?: Promise<unknown>;
  /** Absent in tests that assemble the module without Work coordination. */
  guard?: OutcomeGuard;
}

/** Why a start is refused where the local factory does not run the companion. */
export const NO_FACTORY_START =
  "the local factory is not available here; save the idea to Scratchpad or continue it manually";

/** The most questions one `ask_human` call carries. */
const MAX_QUESTIONS = 5;

/**
 * Answers to grouped questions, `answer-<n>` typed text over `choice-<n>`; `null` when the
 * form answers a single question with `answer`.
 */
function answersFrom(field: OutcomeFields): string[] | null {
  const answers = Array.from(
    { length: MAX_QUESTIONS },
    (_, index) => field(`answer-${index}`).trim() || field(`choice-${index}`).trim(),
  );
  const named = Array.from({ length: MAX_QUESTIONS }, (_, index) =>
    [`answer-${index}`, `choice-${index}`].some((name) => field(name) !== ""),
  );
  return named.some(Boolean) ? answers : null;
}

function assertWorksetId(id: string): void {
  if (!isWorksetId(id)) {
    throw new WorksetError(`Workset identifier ${JSON.stringify(id)} is not a kebab-case name`);
  }
}

/** What the Outcome action policy reads of a Workset. */
const outcomeFacts = (id: string, workset: WorksetWithStage) => ({
  id,
  stage: workset.derived.stage,
  stageLabel: workset.derived.label,
  changes: workset.record.changes,
});

/**
 * The Workset `action` targets once the Outcome action policy accepts it; refused with a
 * reason, changing nothing, otherwise. `undefined` for Start or Later on a Workset without a
 * derived stage, whose record write then says why.
 */
async function acceptedAction(
  id: string,
  action: OutcomeAction,
  companion: {
    stages: WorksetStagesReader;
    runner: boolean;
    /** The Workset's run; none without the runner. */
    run?: () => Promise<OutcomeRunFacts>;
  },
): Promise<WorksetWithStage | undefined> {
  assertWorksetId(id);
  if (!isOutcomeAction(action)) {
    throw new WorksetError(`unknown factory action ${JSON.stringify(action)}`);
  }
  const workset = (await companion.stages()).worksets.find((entry) => entry.record.id === id);
  if (!workset) {
    if (action === "start" || action === "later") return undefined;
    throw new StageError(`this companion has no valid Workset ${id}`);
  }
  const refusal = outcomeRefusal(action, outcomeFacts(id, workset), await companion.run?.(), {
    runner: companion.runner,
  });
  if (refusal) throw new StageError(refusal);
  return workset;
}

/** A new Outcome from the outcome input, and whether it was started. */
export async function createOutcomeFrom(
  companionPath: string,
  fields: OutcomeFields,
): Promise<{ id: string; started: boolean }> {
  const start = fields("start") !== "later";
  const ticket = fields("ticket").trim();
  if (ticket && (await companionTicketFormat(companionPath)) !== "jira") {
    throw new WorksetError(TICKETS_OFF);
  }
  const record = await createOutcome(
    companionPath,
    {
      text: fields("text"),
      repository: fields("repository"),
      ...(start ? { start } : {}),
      ...(ticket ? { ticket } : {}),
    },
    await linkedRepositoryIdentities(companionPath),
  );
  return { id: record.id, started: start };
}

/**
 * A companion's Outcomes without the AFK runner: Start and Later change only the record's
 * start time, and the policy refuses every other action.
 */
export function recordOutcomes(companionPath: string, stages: WorksetStagesReader): Outcomes {
  return {
    companionPath,
    automated: false,
    async act(id, action) {
      // Without the factory nothing may be started; Later only clears an earlier start.
      if (action === "start") throw new StageError(NO_FACTORY_START);
      await acceptedAction(id, action, { stages, runner: false });
      await setWorksetStarted(companionPath, id, false);
    },
    async create(fields) {
      if (fields("start") !== "later") throw new StageError(NO_FACTORY_START);
      await createOutcomeFrom(companionPath, fields);
    },
    runs: async () => null,
  };
}

function assemble(parts: OutcomesParts) {
  const { runner, runs, companionPath, client, stages, reports, sessions, guard } = parts;
  const ready = parts.ready ?? Promise.resolve();
  const busy = () => sessions.busy();

  // One pickup at a time, so two triggers cannot queue the same Workset twice.
  const pickUp = serialized("factory pickup", () => pickUpReady({ runner, companionPath, busy }));
  const refused = new Set<string>();
  const doneWorksets = doneWorksetsFrom(stages);
  const reclaim = serialized("reclaiming Done Worksets", async (settled?: string) => {
    const ids = await reclaimDone({ client, runs, runner, doneWorksets, busy, refused }, settled);
    for (const id of ids) process.stderr.write(`mate studio: reclaimed Done Workset ${id}\n`);
  });
  runner.live.onSettled((id) => {
    void pickUp();
    void reclaim(id);
  });
  // A session's end may free the container a waiting run needs.
  sessions.onEnded(() => runner.retrySlots());

  const runFacts = async (id: string) => {
    const { execution, control, conversation } = await runs.facts(id);
    return {
      state: execution.state,
      ...(control.mode === "automatic" ? {} : { control }),
      ...(conversation ? { conversation: true } : {}),
    };
  };

  /** Clears the start and drops a queued run, re-checked under the lock: work may have begun. */
  const moveToLater = (id: string) =>
    runner.park(
      id,
      async (running) => {
        const current = (await stages()).worksets.find((entry) => entry.record.id === id);
        if (!current) return null;
        const run = await runFacts(id);
        const facts = running ? { ...run, state: "running" as const } : run;
        return outcomeRefusal("later", outcomeFacts(id, current), facts, { runner: true });
      },
      async () => {
        await setWorksetStarted(companionPath, id, false);
        // Back to Scratchpad; a claim stays.
        const refusal = await guard?.release(id);
        if (refusal) throw new StageError(refusal);
      },
    );

  /**
   * Stops a live run, then ends the person's open session and removes the container and
   * worktree, the run state and, last, the record; the first failure keeps the record, so the
   * Outcome stays on the board to retry. A refusal stops nothing.
   */
  const deleteOutcome = async (id: string) => {
    const refusal = async () => {
      const current = (await stages()).worksets.find((entry) => entry.record.id === id);
      if (!current) return `this companion has no valid Workset ${id}`;
      return outcomeRefusal("delete", outcomeFacts(id, current), await runFacts(id), {
        runner: true,
      });
    };
    await runner.stop(id, refusal);
    await runner.discard(id, refusal, async () => {
      await sessions.close(companionPath, id, "deleted");
      if ((await client.list()).some((workset) => workset.id === id)) await client.delete(id);
      await runs.forget(id);
      await removeWorkset(companionPath, id);
    });
  };

  const outcomes: FactoryOutcomes = {
    companionPath,
    automated: true,
    async act(id, action, fields) {
      const workset = await acceptedAction(id, action, {
        stages,
        runner: true,
        run: () => ready.then(() => runFacts(id)),
      });
      await ready;
      if (action === "start") {
        const refusal = await guard?.reserve(id);
        if (refusal) throw new StageError(refusal);
        await setWorksetStarted(companionPath, id, true);
        await runner.rerank(id);
        await pickUp();
        return;
      }
      if (action === "later") {
        await moveToLater(id);
        await pickUp();
        return;
      }
      switch (action) {
        case "answer": {
          const round = fields("round");
          if (!round) throw new StageError("the answer names no question round; reload the page");
          return runner.answer(id, answersFrom(fields) ?? fields("answer"), round);
        }
        case "take-control":
          return runner.takeControl(id);
        case "return":
          return runner.returnToAutomation(id);
        case "retry":
          return runner.retry(id);
        case "cancel":
          return runner.cancel(id);
        // Before archive the changes are revised; after it, a follow-up change carries the feedback.
        case "feedback":
          return runner.feedback(id, fields("feedback"), workset?.derived.stage === "merge-wait");
        // A revise without feedback only rebuilds the reports.
        case "regenerate":
          return runner.request(id, "revise");
        case "start-apply":
          return runner.request(id, "apply");
        case "publish":
          return runner.request(id, "publish");
        case "delete":
          return deleteOutcome(id);
      }
    },
    async create(fields) {
      await ready;
      // Saved unstarted first: a pickup during the reserve must not find it queued.
      const created = await createOutcomeFrom(companionPath, (name) =>
        name === "start" ? "later" : fields(name),
      );
      if (fields("start") === "later") return;
      const refusal = await guard?.reserve(created.id);
      // Kept as an unstarted idea in Scratchpad.
      if (refusal) throw new StageError(`saved to Scratchpad but not started: ${refusal}`);
      await setWorksetStarted(companionPath, created.id, true);
      await pickUp();
    },
    runs: () => runViews(runs, companionPath, () => reports.ids()),
    async dispatch(id, mode, expected) {
      await ready;
      assertWorksetId(id);
      if (runner.isActive(id)) throw new StageError(`Workset ${id} already has a run`);
      const plan = await dispatchPlan(companionPath, id, expected.members);
      const refusal = await guard?.reserve(id);
      if (refusal) throw new StageError(refusal);
      await materializeForFactory(companionPath, plan, mode);
      await runner.rerank(id);
      if (plan.resume) {
        // An incomplete plan resumes planning on the same changes; nothing is re-proposed.
        await runner.request(id, "propose");
      } else {
        await pickUp();
      }
    },
    async park(id) {
      await ready;
      assertWorksetId(id);
      await runner.park(
        id,
        async (running) => {
          if (running) return "the run is active; cancel it first";
          const current = (await stages()).worksets.find((entry) => entry.record.id === id);
          if (!current) return `this companion has no valid Workset ${id}`;
          const stage = current.derived.stage;
          if (current.record.changes.length === 0)
            return "nothing is planned yet; use Move to later";
          if (stage !== "propose" && stage !== "human-review") {
            return "implementation has begun; it cannot be parked";
          }
          const run = await runFacts(id);
          if (run.state === "running" || run.state === "waiting") {
            return "the run is active; cancel it first";
          }
          return null;
        },
        async () => {
          await setWorksetStarted(companionPath, id, false);
          const refusal = await guard?.release(id);
          if (refusal) throw new StageError(refusal);
        },
      );
      await pickUp();
    },
    log: (id) => runs.readLog(id),
    watch: (id) => runner.live.watch(id),
    onChanged(listener) {
      return runner.live.onSettled(() => listener());
    },
    async takenOver(id) {
      const facts = await runs.facts(id);
      if (facts.control.mode !== "manual") return null;
      return { claudeSession: facts.claudeSession };
    },
    async returnAfterExit(id) {
      await ready;
      if (!(await outcomes.takenOver(id))) return;
      try {
        await runner.returnToAutomation(id);
      } catch (error) {
        process.stderr.write(
          `mate studio: returning ${id} to automation after Claude exited failed: ${(error as Error).message}\n`,
        );
      }
    },
  };
  return { outcomes, pickUp, reclaim };
}

/** The module from a built runner and its ports, with no startup pickup or reclaim. */
export function factoryOutcomes(parts: OutcomesParts): FactoryOutcomes {
  return assemble(parts).outcomes;
}

/**
 * Moves legacy shared records this installation started, before records became local, into
 * the scratchpad still started. Its own run state vouches for them; the inbox cannot forge it.
 */
export async function adoptLegacyStarts(companionPath: string, runs: Run): Promise<string[]> {
  const { worksets } = await readWorksets(companionPath);
  const adopted: string[] = [];
  for (const record of worksets) {
    if (!record.legacy || !record.queuedAt) continue;
    // oxlint-disable-next-line no-await-in-loop -- a few legacy records, once at startup
    if (!(await runs.facts(record.id)).recorded) continue;
    // oxlint-disable-next-line no-await-in-loop -- same record
    await writeWorkset(companionPath, record, { started: true });
    adopted.push(record.id);
  }
  return adopted;
}

/**
 * The factory's Outcomes for the companion the appliance serves; `null` outside factory
 * mode. Starts at once: stale runs are marked interrupted, then started Outcomes are picked
 * up and Done Worksets reclaimed.
 */
export function createFactoryOutcomes(
  companionPath: string | null,
  ports: OutcomesPorts,
  env: NodeJS.ProcessEnv = process.env,
): FactoryOutcomes | null {
  const broker = env[FACTORY_BROKER_ENV];
  const client = factoryClient(broker);
  if (!broker || !client || !companionPath) return null;
  const stateDir = env[FACTORY_STATE_DIR_ENV] || DEFAULT_STATE_DIR;
  const runs = new Run(new RunStore(path.join(stateDir, "runs")));
  const ready = Promise.all([
    runs.interruptActive(),
    runs.control.recover(() => activeChanges(companionPath)),
    adoptLegacyStarts(companionPath, runs),
  ]);

  const harness = createHarnessStageAgent({
    client,
    attachSocket: attachSocketFor(broker),
    runs,
    companionPath,
    worktreeOf: (id) => path.join(stateDir, "worktrees", id),
    home: WORKSET_HOME,
  });
  // Checked per turn: the broker holds the credential and may have none.
  const agent: StageAgent = {
    async turn(request) {
      await requireAgentCredential(client);
      // A Workset may reach Ready without a session, so the turn spawns its container.
      const { warnings } = await prepareWorkset(
        client,
        companionPath,
        request.worksetId,
        env,
        memorySizeFor(request.stage),
      );
      for (const warning of warnings) request.onText(`\n${warning}\n`);
      return harness.turn(request);
    },
  };

  const gitEnv = factoryGitEnv(env);
  const recordFor = (id: string) => findWorkset(companionPath, id);
  const guard = companionExecutorGuard(companionPath);
  const runner: FactoryRunner = new FactoryRunner({
    authorized: guard.authorized,
    runs,
    ...runnerLimits(env),
    depsFor: (id) => ({
      companionPath,
      stateDir,
      agent,
      storeReport: (change, file) => storeReviewReport(runs, ports.reports, id, change, file),
      // Publications commit too, so every command the runner starts carries the author.
      run: (command, args, cwd) => runCommand(command, args, { cwd, env: gitEnv }),
    }),
    rankFor: async (id) => {
      const record = await recordFor(id);
      return record ? rankOf(record) : null;
    },
    recordFor,
    sessionLive: (id) => ports.sessions.busy().has(id),
    endSession: (id) => ports.sessions.close(companionPath, id, "returned"),
  });
  const { outcomes, pickUp, reclaim } = assemble({
    ...ports,
    runner,
    runs,
    companionPath,
    client,
    ready,
    guard,
  });
  void ready.then(
    () => {
      void pickUp();
      // Done Worksets from before this start; afterwards, after every settled run.
      void reclaim();
    },
    (error: unknown) => {
      process.stderr.write(
        `mate studio: the factory runner did not start: ${(error as Error).message}\n`,
      );
    },
  );
  // A safety net: every other pickup trigger is an event in this process.
  setInterval(
    () =>
      void ready.then(
        () => pickUp(),
        () => {},
      ),
    60 * 60 * 1000,
  ).unref();
  return outcomes;
}
