import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CLAUDE_SESSION_ID } from "../attach-client";
import type { AgentQuestion } from "./questions";

/**
 * One run state and one bounded log per Workset, on the factory state volume. They
 * describe this appliance's execution, not the Workset's intent, so they live beside
 * the clones rather than in the companion.
 */

export type RunStage =
  | "clarify"
  | "explore"
  | "propose"
  | "revise"
  | "apply"
  | "archive"
  | "publish";

export { type AgentQuestion, questionsOf } from "./questions";

export type RunState =
  | { state: "idle"; updatedAt: string }
  | {
      state: "queued";
      stage: RunStage;
      /**
       * Why the run waits: every running Workset container is busy (`workset-slot`), or
       * the build stages are at their cap (`build-slot`).
       */
      waiting?: "workset-slot" | "build-slot";
      updatedAt: string;
    }
  | { state: "running"; stage: RunStage; startedAt: string; updatedAt: string }
  | {
      state: "waiting";
      stage: RunStage;
      /** Asked together, in order; a person answers them in one go. */
      questions: AgentQuestion[];
      /**
       * This question round; an answer names it, and only one answer per round counts.
       * Missing only in states written before rounds; `RunStore.read` fills it in.
       */
      round?: string;
      updatedAt: string;
    }
  | { state: "failed"; stage: RunStage; reason: string; updatedAt: string }
  | { state: "interrupted"; stage: RunStage; updatedAt: string };

const UNANSWERED = "no answer; take your recommendation";

/**
 * What a person's answers say to the agent: one answer as written, several as each
 * question with its answer. `null` when every answer is empty.
 */
export function answerText(questions: AgentQuestion[], answers: string[]): string | null {
  const trimmed = questions.map((_, index) => answers[index]?.trim() ?? "");
  if (trimmed.every((answer) => answer === "")) return null;
  if (questions.length <= 1) return trimmed[0] ?? null;
  return questions
    .map(
      (asked, index) => `${index + 1}. ${asked.question}\nAnswer: ${trimmed[index] || UNANSWERED}`,
    )
    .join("\n\n");
}

/** One check the agent ran, as it reported it. */
export interface SituationCheck {
  name: string;
  passed: boolean;
}

/** What the agent told a person about the Outcome at the end of a stage. */
export interface Situation {
  text: string;
  at: string;
  stage?: RunStage;
  checks?: SituationCheck[];
}

export const SITUATION_HISTORY = 10;

/** The memory with `situation` as its newest situation, keeping the last ten. */
export function withSituation(memory: RunMemory, situation: Situation): RunMemory {
  return {
    ...memory,
    situations: [situation, ...(memory.situations ?? [])].slice(0, SITUATION_HISTORY),
  };
}

/** What a later turn needs to continue the Workset's conversation; opaque to Mate. */
export interface RunMemory {
  /** The harness's resume state from the last turn, when it could be read. */
  resume?: unknown;
  /** The branch the last push reached, for the card's compare link. */
  pushedBranch?: string;
  /** Studio's stored review report per proposed change. */
  reviewReports?: Record<string, string>;
  /** What the agent reported for a person, newest first. */
  situations?: Situation[];
}

/**
 * Who drives the Outcome's conversation: the factory, a person once the running stage ends,
 * or a person now. Only Return to automation hands it back.
 */
export type ControlMode = "automatic" | "takeover-requested" | "manual";

export interface ControlState {
  mode: ControlMode;
  /** Why Return to automation failed, kept while the person has control. */
  reason?: string;
  /** The companion's active changes when the person got control; what they add is linked on return. */
  changesBefore?: string[];
  updatedAt: string;
}

/** The Claude session the factory's turns continue, read from the harness's resume data. */
export function claudeSessionOf(memory: RunMemory): string | null {
  const resume = memory.resume as { data?: { claudeSessionId?: unknown } } | undefined;
  const id = resume?.data?.claudeSessionId;
  return typeof id === "string" && CLAUDE_SESSION_ID.test(id) ? id : null;
}

export const LOG_LIMIT_BYTES = 256 * 1024;
const IDLE: RunState = { state: "idle", updatedAt: new Date(0).toISOString() };
const AUTOMATIC: ControlState = { mode: "automatic", updatedAt: new Date(0).toISOString() };

export class RunStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(id: string, suffix: string): string {
    return path.join(this.dir, `${id}.${suffix}`);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  stamp(): string {
    return this.now().toISOString();
  }

  async read(id: string): Promise<RunState> {
    const state = await this.readJson(this.file(id, "json"), IDLE);
    // A legacy round's id derives from the state itself, so every reader agrees without a write.
    if (state.state === "waiting" && !state.round)
      return { ...state, round: `legacy-${state.updatedAt}` };
    return state;
  }

  async write(id: string, state: RunState): Promise<void> {
    await this.writeJson(this.file(id, "json"), state);
  }

  async hasState(id: string): Promise<boolean> {
    return (await fs.stat(this.file(id, "json")).catch(() => null)) !== null;
  }

  readMemory(id: string): Promise<RunMemory> {
    return this.readJson(this.file(id, "memory.json"), {});
  }

  async writeMemory(id: string, memory: RunMemory): Promise<void> {
    await this.writeJson(this.file(id, "memory.json"), memory);
  }

  /** Automatic unless a person took control; records from before control read automatic. */
  readControl(id: string): Promise<ControlState> {
    return this.readJson(this.file(id, "control.json"), AUTOMATIC);
  }

  async writeControl(id: string, control: ControlState): Promise<void> {
    await this.writeJson(this.file(id, "control.json"), control);
  }

  /** Appends to the log, keeping only its newest bytes. */
  async log(id: string, text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.file(id, "log");
    await fs.appendFile(file, text, "utf8");
    const stat = await fs.stat(file);
    if (stat.size > LOG_LIMIT_BYTES) {
      const content = await fs.readFile(file);
      await fs.writeFile(file, content.subarray(content.byteLength - LOG_LIMIT_BYTES));
    }
  }

  /** Forgets the Workset's run: its state, memory, control and log. */
  async remove(id: string): Promise<void> {
    await Promise.all(
      ["json", "memory.json", "control.json", "log"].map((suffix) =>
        fs.rm(this.file(id, suffix), { force: true }),
      ),
    );
  }

  async hasLog(id: string): Promise<boolean> {
    const stat = await fs.stat(this.file(id, "log")).catch(() => null);
    return (stat?.size ?? 0) > 0;
  }

  async readLog(id: string): Promise<string> {
    return fs.readFile(this.file(id, "log"), "utf8").catch(() => "");
  }

  async all(): Promise<Map<string, RunState>> {
    const entries = await fs.readdir(this.dir).catch((): string[] => []);
    const ids = entries.flatMap((name) =>
      name.endsWith(".json") && !name.endsWith(".memory.json") && !name.endsWith(".control.json")
        ? [name.slice(0, -".json".length)]
        : [],
    );
    return new Map(await Promise.all(ids.map(async (id) => [id, await this.read(id)] as const)));
  }
}
