import { randomUUID } from "node:crypto";

import { KeyedSerial } from "../keyed-serial";
import { OutcomeControl } from "./control";
import { retryRefusal, runnableStage } from "./run-policy";
import {
  type AgentQuestion,
  answerText,
  claudeSessionOf,
  type ControlState,
  questionsOf,
  type RunMemory,
  type RunStage,
  type RunState,
  type RunStore,
  type Situation,
  withSituation,
} from "./state";
import { StageError } from "./workflow";

export interface RunFacts {
  execution: RunState;
  /** An idle default does not imply a persisted run. */
  recorded: boolean;
  control: ControlState;
  claudeSession: string | null;
  conversation: boolean;
  memory: Omit<RunMemory, "resume">;
  hasLog: boolean;
}

type ReportedSituation = Omit<Situation, "at" | "stage">;

/** Owns a companion's Run transitions and memory; scheduling remains process-local, control is `control`'s. */
export class Run {
  private readonly memoryUpdates = new KeyedSerial();

  /** Who drives each Outcome's conversation; the only writer of control state. */
  readonly control: OutcomeControl;

  constructor(private readonly store: RunStore) {
    this.control = new OutcomeControl(store);
  }

  async facts(id: string): Promise<RunFacts> {
    const [execution, recorded, control, memory, hasLog] = await Promise.all([
      this.store.read(id),
      this.store.hasState(id),
      this.store.readControl(id),
      this.store.readMemory(id),
      this.store.hasLog(id),
    ]);
    const { resume: _, ...visible } = memory;
    const claudeSession = claudeSessionOf(memory);
    return {
      execution,
      recorded,
      control,
      claudeSession,
      conversation: claudeSession !== null,
      memory: visible,
      hasLog,
    };
  }

  async allFacts(ids?: readonly string[]): Promise<Map<string, RunFacts>> {
    const entries = ids ?? [...(await this.store.all()).keys()];
    return new Map(
      await Promise.all(entries.map(async (id) => [id, await this.facts(id)] as const)),
    );
  }

  async resume(id: string): Promise<unknown> {
    return (await this.store.readMemory(id)).resume;
  }

  queue(id: string, stage: RunStage, waiting?: "workset-slot" | "build-slot"): Promise<void> {
    return this.store.write(id, {
      state: "queued",
      stage,
      ...(waiting ? { waiting } : {}),
      updatedAt: this.store.stamp(),
    });
  }

  start(id: string, stage: RunStage): Promise<void> {
    const startedAt = this.store.stamp();
    return this.store.write(id, { state: "running", stage, startedAt, updatedAt: startedAt });
  }

  wait(id: string, stage: RunStage, questions: AgentQuestion[]): Promise<void> {
    return this.store.write(id, {
      state: "waiting",
      stage,
      questions,
      round: randomUUID(),
      updatedAt: this.store.stamp(),
    });
  }

  settle(id: string): Promise<void> {
    return this.store.write(id, { state: "idle", updatedAt: this.store.stamp() });
  }

  fail(id: string, stage: RunStage, reason: string): Promise<void> {
    return this.store.write(id, { state: "failed", stage, reason, updatedAt: this.store.stamp() });
  }

  /** The scheduler consumes this under its per-Workset answer lock. */
  async prepareAnswer(id: string, answers: string | string[], round?: string) {
    const state = await this.store.read(id);
    if (round !== undefined && (state.state !== "waiting" || state.round !== round)) {
      throw new StageError("this question was already answered");
    }
    if (state.state !== "waiting")
      throw new StageError(`Workset ${id} is not waiting for an answer`);
    const text = answerText(questionsOf(state), typeof answers === "string" ? [answers] : answers);
    if (text === null) throw new StageError("an answer cannot be empty");
    return { stage: runnableStage(state.stage), text };
  }

  async retryStage(id: string) {
    const state = await this.store.read(id);
    const refusal = retryRefusal(id, state.state);
    if (refusal) throw new StageError(refusal);
    return runnableStage((state as Extract<RunState, { state: "failed" | "interrupted" }>).stage);
  }

  /** Restart never resumes a stage: running and queued runs become interrupted. */
  async interruptActive(): Promise<string[]> {
    const interrupted: string[] = [];
    await Promise.all(
      [...(await this.store.all())].map(async ([id, state]) => {
        if (state.state !== "running" && state.state !== "queued") return;
        interrupted.push(id);
        await this.store.write(id, {
          state: "interrupted",
          stage: state.stage,
          updatedAt: this.store.stamp(),
        });
      }),
    );
    return interrupted.toSorted();
  }

  private updateMemory(
    id: string,
    update: (memory: RunMemory) => RunMemory | Promise<RunMemory>,
  ): Promise<void> {
    return this.memoryUpdates.run(id, async () => {
      await this.store.writeMemory(id, await update(await this.store.readMemory(id)));
    });
  }

  saveTurn(id: string, resume?: unknown, situation?: ReportedSituation): Promise<void> {
    return this.updateMemory(id, async (memory) => {
      const next = { ...memory, ...(resume ? { resume } : {}) };
      if (!situation) return next;
      const state = await this.store.read(id);
      return withSituation(next, {
        ...situation,
        at: this.store.stamp(),
        ...(state.state === "idle" ? {} : { stage: state.stage }),
      });
    });
  }

  rememberPush(id: string, branch: string): Promise<void> {
    return this.updateMemory(id, (memory) => ({ ...memory, pushedBranch: branch }));
  }

  rememberReview(id: string, change: string, report: string): Promise<void> {
    return this.updateMemory(id, (memory) => ({
      ...memory,
      reviewReports: { ...memory.reviewReports, [change]: report },
    }));
  }

  recordSituation(id: string, situation: ReportedSituation, stage?: RunStage): Promise<void> {
    return this.updateMemory(id, (memory) =>
      withSituation(memory, {
        ...situation,
        at: this.store.stamp(),
        ...(stage ? { stage } : {}),
      }),
    );
  }

  forget(id: string): Promise<void> {
    return this.store.remove(id);
  }

  log(id: string, text: string): Promise<void> {
    return this.store.log(id, text);
  }
  readLog(id: string): Promise<string> {
    return this.store.readLog(id);
  }
}
