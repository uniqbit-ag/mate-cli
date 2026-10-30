import type { RunStage, RunStore } from "./state";
import { type StageOutcome, StageError, STAGES, type WorkflowDeps } from "./workflow";

/**
 * Runs Worksets' agent stages, a bounded number at once and the rest in request order.
 * Every stage has a time budget; cancelling or exceeding it aborts the turn, which
 * closes the harness bridge's attach so the broker stops the agent in its container.
 */

export type RunnableStage = Exclude<RunStage, "archive">;

export interface RunnerOptions {
  store: RunStore;
  maxRuns: number;
  stageMs: number;
  /** Everything a stage needs except its abort signal and log. */
  depsFor: (id: string) => Omit<WorkflowDeps, "signal" | "log">;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Request {
  id: string;
  stage: RunnableStage;
  /** A person's answer, sent as the first turn before the stage continues. */
  answer?: string;
}

export class FactoryRunner {
  private readonly queue: Request[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<void>>();

  constructor(private readonly options: RunnerOptions) {}

  isActive(id: string): boolean {
    return this.active.has(id) || this.queue.some((request) => request.id === id);
  }

  /** Resolves once the Workset's current run has ended; for tests and shutdown. */
  async idle(id: string): Promise<void> {
    if (!this.isActive(id)) return;
    await (this.settled.get(id) ?? new Promise((resolve) => setTimeout(resolve, 5)));
    return this.idle(id);
  }

  async request(id: string, stage: RunnableStage, answer?: string): Promise<void> {
    if (this.isActive(id)) throw new StageError(`Workset ${id} already has a run`);
    this.queue.push({ id, stage, ...(answer === undefined ? {} : { answer }) });
    await this.options.store.write(id, {
      state: "queued",
      stage,
      updatedAt: this.options.store.stamp(),
    });
    this.pump();
  }

  async answer(id: string, text: string): Promise<void> {
    const state = await this.options.store.read(id);
    if (state.state !== "waiting")
      throw new StageError(`Workset ${id} is not waiting for an answer`);
    if (text.trim() === "") throw new StageError("an answer cannot be empty");
    await this.request(id, state.stage === "archive" ? "apply" : state.stage, text);
  }

  async retry(id: string): Promise<void> {
    const state = await this.options.store.read(id);
    if (state.state !== "failed" && state.state !== "interrupted") {
      throw new StageError(`Workset ${id} has no failed or interrupted run to retry`);
    }
    await this.request(id, state.stage === "archive" ? "apply" : state.stage);
  }

  async cancel(id: string): Promise<void> {
    const queued = this.queue.findIndex((request) => request.id === id);
    if (queued !== -1) {
      const [request] = this.queue.splice(queued, 1);
      await this.fail(id, request!.stage, "cancelled");
      return;
    }
    const controller = this.active.get(id);
    if (!controller) throw new StageError(`Workset ${id} has no run to cancel`);
    controller.abort(new StageError("cancelled"));
  }

  private pump(): void {
    while (this.active.size < this.options.maxRuns && this.queue.length > 0) {
      const request = this.queue.shift()!;
      const controller = new AbortController();
      this.active.set(request.id, controller);
      this.settled.set(
        request.id,
        this.execute(request, controller).finally(() => {
          this.active.delete(request.id);
          this.settled.delete(request.id);
          this.pump();
        }),
      );
    }
  }

  private async fail(id: string, stage: RunStage, reason: string): Promise<void> {
    await this.options.store.write(id, {
      state: "failed",
      stage,
      reason,
      updatedAt: this.options.store.stamp(),
    });
  }

  private async execute(request: Request, controller: AbortController): Promise<void> {
    const { store } = this.options;
    const setTimer = this.options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer =
      this.options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const minutes = Math.round(this.options.stageMs / 60_000);
    const budget = setTimer(
      () => controller.abort(new StageError(`the stage exceeded its budget of ${minutes} minutes`)),
      this.options.stageMs,
    );
    const started = store.stamp();
    await store.write(request.id, {
      state: "running",
      stage: request.stage,
      startedAt: started,
      updatedAt: started,
    });
    const deps: WorkflowDeps = {
      ...this.options.depsFor(request.id),
      signal: controller.signal,
      log: (text) => void store.log(request.id, text).catch(() => {}),
      onPushed: async (branch) => {
        await store.writeMemory(request.id, {
          ...(await store.readMemory(request.id)),
          pushedBranch: branch,
        });
      },
    };
    try {
      // The stage runs the answer as its first turn, so it can count what that turn did.
      const outcome: StageOutcome = await STAGES[request.stage](deps, request.id, request.answer);
      if (outcome.kind === "question") return await this.wait(request, outcome.question);
      await store.write(request.id, { state: "idle", updatedAt: store.stamp() });
    } catch (error) {
      const reason = controller.signal.aborted
        ? ((controller.signal.reason as Error)?.message ?? "aborted")
        : error instanceof StageError
          ? error.message
          : `the stage failed: ${(error as Error).message}`;
      await this.fail(request.id, request.stage, reason);
    } finally {
      clearTimer(budget);
    }
  }

  private async wait(request: Request, question: string): Promise<void> {
    await this.options.store.write(request.id, {
      state: "waiting",
      stage: request.stage,
      question,
      updatedAt: this.options.store.stamp(),
    });
  }
}
