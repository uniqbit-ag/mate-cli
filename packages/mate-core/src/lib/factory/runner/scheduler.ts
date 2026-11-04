import path from "node:path";

import { activeChanges, changesDirOf } from "../../change-layout";
import { findWorkset, type WorksetRecord } from "../../workset/record";
import { FactoryError } from "../ids";
import { KeyedSerial } from "../keyed-serial";
import { LiveTurns } from "./live";
import type { Baseline } from "./control";
import { compareRanked } from "./rank";
import type { Run } from "./run";
import type { RunStage } from "./state";
import {
  BUILD_STAGES,
  linkCreatedChanges,
  PROMPTS,
  RETURN_NOTE,
  type StageOutcome,
  StageError,
  STAGES,
  taskCounts,
  type WorkflowDeps,
} from "./workflow";

/**
 * Runs Worksets' agent stages, a bounded number at once and the rest by their Workset's
 * rank (see `rank.ts`); Later Outcomes' requests go last, in request order.
 * Every stage has a time budget; cancelling or exceeding it aborts the turn, which
 * closes the harness bridge's attach so the broker stops the agent in its container.
 */

export type RunnableStage = Exclude<RunStage, "archive">;

const PICKABLE = {
  "clarify-intent": "clarify",
  explore: "explore",
  ready: "propose",
} as const satisfies Record<WorksetRecord["stage"], RunnableStage & keyof typeof PROMPTS>;

/** The stage the runner starts by itself for a started Outcome, if any. */
export function pickableStage(
  record: WorksetRecord,
): (typeof PICKABLE)[WorksetRecord["stage"]] | null {
  if (!record.queuedAt || record.changes.length > 0) return null;
  return PICKABLE[record.stage];
}

export interface RunnerOptions {
  runs: Run;
  maxRuns: number;
  /** How many of the running stages may be builds; `maxRuns` when absent. */
  maxBuilds?: number;
  stageMs: number;
  /** Everything a stage needs except its abort signal and log. */
  depsFor: (id: string) => Omit<WorkflowDeps, "signal" | "log">;
  /** The Workset's rank when its request is queued; `null` while Later. Defaults to all Later. */
  rankFor?: (id: string) => Promise<number | null>;
  /** The Workset's identity for prompts the runner builds itself. */
  recordFor?: (id: string) => Promise<Pick<WorksetRecord, "id" | "title"> | undefined>;
  /** Whether a person works on the Workset in a live session; pickup and Return to automation wait for it. */
  sessionLive?: (id: string) => boolean;
  /** Told once a Workset's run has ended, whatever its outcome; pickup hangs off this. */
  onSettled?: (id: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** How often runs waiting for a Workset container slot try again, besides settles and session ends. */
export const SLOT_RETRY_MS = 30_000;

function isSlotBusy(error: unknown): boolean {
  return error instanceof FactoryError && error.code === "busy";
}

/** Why a stage failed, as its run records it. */
function failureReason(signal: AbortSignal, error: unknown): string {
  if (signal.aborted) return (signal.reason as Error)?.message ?? "aborted";
  if (error instanceof StageError) return error.message;
  return `the stage failed: ${(error as Error).message}`;
}

interface Request {
  id: string;
  stage: RunnableStage;
  /** A person's answer, sent as the first turn before the stage continues. */
  answer?: string;
  /** A person's feedback for a revise stage, which builds its own prompt from it. */
  feedback?: string;
  rank: number | null;
  /** Refused a Workset container slot; skipped until `retrySlots`. */
  slotWait?: boolean;
  /** Recorded as waiting for a build slot, so the wait is written once. */
  buildWait?: boolean;
}

export class FactoryRunner {
  private readonly queue: Request[] = [];
  private readonly active = new Map<string, AbortController>();
  /** The active runs whose stage is a build. */
  private readonly building = new Set<string>();
  /** Build-slot waits being recorded; a run starting meanwhile writes its state after them. */
  private readonly waitWrites = new Map<string, Promise<void>>();
  private readonly settled = new Map<string, Promise<void>>();
  /** Each Workset's tasks run after every earlier one has settled. */
  private readonly locks = new KeyedSerial();
  private slotRetry: unknown = null;
  /** What running turns show, for people following a run. */
  readonly live: LiveTurns;

  constructor(private readonly options: RunnerOptions) {
    this.live = new LiveTurns(options.runs);
  }

  isActive(id: string): boolean {
    return this.active.has(id) || this.queue.some((request) => request.id === id);
  }

  /** Resolves once the Workset's current run has ended; for tests and shutdown. */
  async idle(id: string): Promise<void> {
    if (!this.isActive(id)) return;
    await (this.settled.get(id) ?? new Promise((resolve) => setTimeout(resolve, 5)));
    return this.idle(id);
  }

  async request(
    id: string,
    stage: RunnableStage,
    answer?: string,
    feedback?: string,
  ): Promise<void> {
    if (this.isActive(id)) throw new StageError(`Workset ${id} already has a run`);
    await this.options.runs.control.requireAutomatic(id);
    const rank = (await this.options.rankFor?.(id)) ?? null;
    // The rank lookup awaited; another request may have won meanwhile.
    if (this.isActive(id)) throw new StageError(`Workset ${id} already has a run`);
    this.queue.push({
      id,
      stage,
      rank,
      ...(answer === undefined ? {} : { answer }),
      ...(feedback === undefined ? {} : { feedback }),
    });
    await this.options.runs.queue(id, stage);
    this.pump();
  }

  /**
   * Answers to the waiting questions, in their order; one answer for one question. With
   * `round`, only an answer to that round counts: card and terminal answers race here, and
   * the second is told the question was already answered.
   */
  answer(id: string, answers: string | string[], round?: string): Promise<void> {
    return this.locks.run(id, async () => {
      const { stage, text } = await this.options.runs.prepareAnswer(id, answers, round);
      await this.request(id, stage, text);
    });
  }

  /**
   * A person takes over the Outcome's conversation: no further stage starts, so a queued one
   * is dropped, and a running one finishes first; until then control is requested. Never
   * cancels work.
   */
  takeControl(id: string): Promise<void> {
    return this.locks.run(id, async () => {
      const { control } = this.options.runs;
      if (await control.withPerson(id)) return;
      await this.dequeue(id);
      await control.take(id, this.active.has(id), this.baseline(id));
    });
  }

  /**
   * Starts the stage pickup chose unless the Outcome is busy, not idle or with a person; true
   * when it was requested. Under the Workset's lock, so it never races Return to automation.
   */
  pickUp(id: string, stage: RunnableStage): Promise<boolean> {
    return this.locks.run(id, async () => {
      if (this.isActive(id) || this.options.sessionLive?.(id)) return false;
      const { execution, control } = await this.options.runs.facts(id);
      // A person has the conversation; only Return to automation continues it.
      if (execution.state !== "idle" || control.mode !== "automatic") return false;
      await this.request(id, stage);
      return true;
    });
  }

  /**
   * Return to automation, refused while the Outcome's session is live: links the changes the
   * person proposed, logs task progress and hands control back, then starts the stage the
   * factory would start by itself, told that a person worked in the conversation. One step
   * under the Workset's lock, so no pickup starts that stage in between. A waiting question
   * stays waiting; failed and later stages wait for a person. On failure the person keeps
   * control, with the reason recorded.
   */
  returnToAutomation(id: string): Promise<void> {
    return this.locks.run(id, async () => {
      if (this.options.sessionLive?.(id)) {
        throw new StageError(
          "exit Claude in the Outcome's terminal first, then return to automation",
        );
      }
      const { runs } = this.options;
      const { companionPath } = this.options.depsFor(id);
      const log = (text: string) => void this.live.log(id, text);
      const returned = await runs.control.giveBack(id, async (changesBefore) => {
        log("\nReturned to automation.\n");
        await linkCreatedChanges({ companionPath, log }, id, changesBefore);
        const record = await findWorkset(companionPath, id);
        const changes = record?.changes ?? [];
        const counts = await Promise.all(
          changes.map((change) => taskCounts(path.join(changesDirOf(companionPath), change))),
        );
        counts.forEach(({ open, done }, index) => {
          if (open + done > 0) log(`${changes[index]}: ${done} of ${open + done} tasks done\n`);
        });
        await this.live.flushed(id);
      });
      if (!returned || this.isActive(id)) return;
      if ((await runs.facts(id)).execution.state !== "idle") return;
      const record = await findWorkset(companionPath, id);
      const stage = record ? pickableStage(record) : null;
      if (!record || !stage) return;
      await this.request(id, stage, `${RETURN_NOTE}\n\n${PROMPTS[stage](record)}`);
    });
  }

  /** The companion's active changes, the baseline of what a person in control adds. */
  private baseline(id: string): Baseline {
    return () => activeChanges(this.options.depsFor(id).companionPath);
  }

  /**
   * A person's feedback on the Outcome: revise its active changes, or, once they are archived,
   * propose a follow-up change in the same conversation.
   */
  async feedback(id: string, text: string, followUp = false): Promise<void> {
    if (text.trim() === "") throw new StageError("feedback cannot be empty");
    if (!followUp) return this.request(id, "revise", undefined, text);
    const record = await this.options.recordFor?.(id);
    if (!record) throw new StageError(`Workset ${id} has no valid record`);
    await this.request(id, "propose", PROMPTS.followUp(record, text));
  }

  async retry(id: string): Promise<void> {
    await this.request(id, await this.options.runs.retryStage(id));
  }

  /** Re-reads a queued request's rank after its Outcome was started. */
  async rerank(id: string): Promise<void> {
    const request = this.queue.find((entry) => entry.id === id);
    if (request) request.rank = (await this.options.rankFor?.(id)) ?? null;
  }

  /** Drops a queued request, leaving the Workset idle; a running one is left to finish. */
  async dequeue(id: string): Promise<boolean> {
    const queued = this.queue.findIndex((request) => request.id === id);
    if (queued === -1) return false;
    this.queue.splice(queued, 1);
    await this.options.runs.settle(id);
    return true;
  }

  async cancel(id: string): Promise<void> {
    const queued = this.queue.findIndex((request) => request.id === id);
    if (queued !== -1) {
      const [request] = this.queue.splice(queued, 1);
      await this.options.runs.fail(id, request!.stage, "cancelled");
      return;
    }
    const controller = this.active.get(id);
    if (!controller) throw new StageError(`Workset ${id} has no run to cancel`);
    controller.abort(new StageError("cancelled"));
  }

  /**
   * Runs waiting for a Workset container slot try again; called when a run settles, a
   * session ends, and on a timer while any waits.
   */
  retrySlots(except?: string): void {
    for (const request of this.queue) {
      if (request.id !== except) request.slotWait = false;
    }
    this.pump();
  }

  private setTimer(callback: () => void, ms: number): unknown {
    return (this.options.setTimer ?? setTimeout)(callback, ms);
  }

  private scheduleSlotRetry(): void {
    if (this.slotRetry !== null) return;
    this.slotRetry = this.setTimer(() => {
      this.slotRetry = null;
      this.retrySlots();
      if (this.queue.some((request) => request.slotWait)) this.scheduleSlotRetry();
    }, SLOT_RETRY_MS);
    (this.slotRetry as { unref?: () => void }).unref?.();
  }

  private pump(): void {
    const maxBuilds = this.options.maxBuilds ?? this.options.maxRuns;
    while (this.active.size < this.options.maxRuns) {
      const buildsFull = this.building.size >= maxBuilds;
      // Stable: equal ranks and Notes keep their request order.
      let next = -1;
      for (let index = 0; index < this.queue.length; index += 1) {
        const candidate = this.queue[index]!;
        if (candidate.slotWait) continue;
        if (buildsFull && BUILD_STAGES.has(candidate.stage)) {
          this.markBuildWait(candidate);
          continue;
        }
        if (next === -1 || compareRanked(candidate, this.queue[next]!) < 0) next = index;
      }
      if (next === -1) return;
      const [request] = this.queue.splice(next, 1) as [Request];
      const controller = new AbortController();
      this.active.set(request.id, controller);
      if (BUILD_STAGES.has(request.stage)) this.building.add(request.id);
      this.settled.set(
        request.id,
        this.execute(request, controller)
          .then((requeued) => (requeued ? undefined : this.handOver(request.id)))
          .catch(() => {})
          .finally(() => {
            this.active.delete(request.id);
            this.building.delete(request.id);
            this.settled.delete(request.id);
            this.live.publish(request.id, { type: "settled" });
            // A settled run may have freed a container; the one just refused waits on.
            this.retrySlots(request.id);
            this.options.onSettled?.(request.id);
          }),
      );
    }
  }

  /** Records once that a queued build waits for a build slot; it keeps its place. */
  private markBuildWait(request: Request): void {
    if (request.buildWait) return;
    request.buildWait = true;
    const written = this.options.runs
      .queue(request.id, request.stage, "build-slot")
      .then(() => this.live.log(request.id, "\nwaiting for a build slot\n"))
      .catch(() => {});
    this.waitWrites.set(request.id, written);
    void written.then(() => {
      if (this.waitWrites.get(request.id) === written) this.waitWrites.delete(request.id);
    });
  }

  /** The stage a takeover waited on has ended: the person has control now. */
  private handOver(id: string): Promise<void> {
    return this.locks.run(id, () => this.options.runs.control.stageEnded(id, this.baseline(id)));
  }

  /** True when the run went back to the queue to wait for a Workset container slot. */
  private async execute(request: Request, controller: AbortController): Promise<boolean> {
    const { runs } = this.options;
    await this.waitWrites.get(request.id);
    const clearTimer =
      this.options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const minutes = Math.round(this.options.stageMs / 60_000);
    const budget = this.setTimer(
      () => controller.abort(new StageError(`the stage exceeded its budget of ${minutes} minutes`)),
      this.options.stageMs,
    );
    await runs.start(request.id, request.stage);
    const deps: WorkflowDeps = {
      ...this.options.depsFor(request.id),
      stage: request.stage,
      signal: controller.signal,
      log: (text, streamed) => void this.live.log(request.id, text, streamed),
      onEvent: (event) => this.live.publish(request.id, event),
      onPushed: async (branch) => {
        await runs.rememberPush(request.id, branch);
      },
    };
    try {
      // The stage runs the answer as its first turn, so it can count what that turn did.
      const outcome: StageOutcome = await STAGES[request.stage](
        deps,
        request.id,
        request.answer,
        request.feedback,
      );
      if (outcome.kind === "question")
        await runs.wait(request.id, request.stage, outcome.questions);
      else await runs.settle(request.id);
      return false;
    } catch (error) {
      if (!controller.signal.aborted && isSlotBusy(error)) {
        // No turn ran, so a requested takeover hands over now instead of waiting for a slot.
        if (await runs.control.withPerson(request.id)) {
          await runs.settle(request.id);
          return false;
        }
        // Back in its place: the queue orders by rank, and the run keeps its own.
        this.queue.push({ ...request, slotWait: true });
        await runs.queue(request.id, request.stage, "workset-slot");
        void this.live.log(
          request.id,
          `\nwaiting for a Workset slot: ${(error as Error).message}\n`,
        );
        this.scheduleSlotRetry();
        return true;
      }
      await runs.fail(request.id, request.stage, failureReason(controller.signal, error));
      return false;
    } finally {
      clearTimer(budget);
      await this.live.flushed(request.id);
    }
  }
}
