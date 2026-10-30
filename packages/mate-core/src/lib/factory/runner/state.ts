import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * One run state and one bounded log per Workset, on the factory state volume. They
 * describe this appliance's execution, not the Workset's intent, so they live beside
 * the clones rather than in the companion.
 */

export type RunStage = "propose" | "apply" | "archive" | "publish";

export type RunState =
  | { state: "idle"; updatedAt: string }
  | { state: "queued"; stage: RunStage; updatedAt: string }
  | { state: "running"; stage: RunStage; startedAt: string; updatedAt: string }
  | { state: "waiting"; stage: RunStage; question: string; updatedAt: string }
  | { state: "failed"; stage: RunStage; reason: string; updatedAt: string }
  | { state: "interrupted"; stage: RunStage; updatedAt: string };

/** What a later turn needs to continue the Workset's conversation; opaque to Mate. */
export interface RunMemory {
  /** The harness's resume state from the last turn, when it could be read. */
  resume?: unknown;
  /** The branch the last push reached, for the card's compare link. */
  pushedBranch?: string;
}

export const LOG_LIMIT_BYTES = 256 * 1024;
const IDLE: RunState = { state: "idle", updatedAt: new Date(0).toISOString() };

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

  read(id: string): Promise<RunState> {
    return this.readJson(this.file(id, "json"), IDLE);
  }

  async write(id: string, state: RunState): Promise<void> {
    await this.writeJson(this.file(id, "json"), state);
  }

  readMemory(id: string): Promise<RunMemory> {
    return this.readJson(this.file(id, "memory.json"), {});
  }

  async writeMemory(id: string, memory: RunMemory): Promise<void> {
    await this.writeJson(this.file(id, "memory.json"), memory);
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

  async readLog(id: string): Promise<string> {
    return fs.readFile(this.file(id, "log"), "utf8").catch(() => "");
  }

  async all(): Promise<Map<string, RunState>> {
    const entries = await fs.readdir(this.dir).catch((): string[] => []);
    const ids = entries.flatMap((name) =>
      name.endsWith(".json") && !name.endsWith(".memory.json")
        ? [name.slice(0, -".json".length)]
        : [],
    );
    return new Map(await Promise.all(ids.map(async (id) => [id, await this.read(id)] as const)));
  }

  /** At startup: a run that was active when Studio stopped is interrupted, never resumed by itself. */
  async interruptActive(): Promise<string[]> {
    const interrupted: string[] = [];
    await Promise.all(
      [...(await this.all())].map(async ([id, state]) => {
        if (state.state === "running" || state.state === "queued") {
          interrupted.push(id);
          await this.write(id, {
            state: "interrupted",
            stage: state.stage,
            updatedAt: this.stamp(),
          });
        }
      }),
    );
    return interrupted.toSorted();
  }
}
