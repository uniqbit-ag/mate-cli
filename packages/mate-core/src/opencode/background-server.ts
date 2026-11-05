import type { Context } from "@opencode/plugin/promise/plugin";

import {
  MATE_OPENCODE_SERVER,
  OPENCODE_PASSWORD,
  OPENCODE_SERVER_PASSWORD,
  removeServerRecordOf,
} from "../runtime/opencode-server-record";

/**
 * The plugin's share of a Mate OpenCode server (`MATE_OPENCODE_SERVER=1`):
 * keep the server password out of every shell, and stop the server after an
 * hour without a running step. Inert in any other OpenCode process.
 */

const IDLE_MS = 60 * 60 * 1000;
const CHECK_MS = 60 * 1000;

export interface MateServerDeps {
  now: () => number;
  exit: (code: number) => void;
  /** Runs `check` every `ms` without keeping the process alive. */
  every: (check: () => void, ms: number) => void;
  removeRecord: (pid: number) => Promise<unknown>;
  pid: number;
}

const defaultDeps: MateServerDeps = {
  now: Date.now,
  exit: (code) => process.exit(code),
  every: (check, ms) => setInterval(check, ms).unref(),
  removeRecord: (pid) => removeServerRecordOf(pid),
  pid: process.pid,
};

function runsInMateServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MATE_OPENCODE_SERVER] === "1";
}

/** `opencode serve` reads its password once at start; nothing after needs it. */
function dropPasswords(env: Record<string, string | undefined>): void {
  delete env[OPENCODE_SERVER_PASSWORD];
  delete env[OPENCODE_PASSWORD];
}

interface StepEvent {
  type?: string;
  data?: { sessionID?: string; finish?: string };
}

/** One per process: plugins set up per location, the server stops as a whole. */
class IdleStop {
  private readonly running = new Set<string>();
  private lastStep: number;
  private started = false;
  private stopping = false;
  readonly onStop = new Set<() => Promise<unknown>>();

  constructor(private readonly deps: MateServerDeps) {
    this.lastStep = deps.now();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.every(() => void this.check(), CHECK_MS);
  }

  /** A step ending in `tool-calls` is followed by the next one: the turn still runs. */
  observe(event: StepEvent): void {
    const id = event.data?.sessionID;
    if (!id || !event.type) return;
    if (event.type === "session.deleted") {
      this.running.delete(id);
      return;
    }
    if (!event.type.startsWith("session.step.")) return;
    this.lastStep = this.deps.now();
    if (event.type === "session.step.started") this.running.add(id);
    const finished =
      event.type === "session.step.failed" ||
      (event.type === "session.step.ended" && event.data?.finish !== "tool-calls");
    if (finished) this.running.delete(id);
  }

  async check(): Promise<void> {
    if (this.stopping || this.running.size > 0) return;
    if (this.deps.now() - this.lastStep < IDLE_MS) return;
    this.stopping = true;
    await Promise.all([...this.onStop].map((stop) => stop().catch(() => {})));
    await this.deps.removeRecord(this.deps.pid).catch(() => {});
    this.deps.exit(0);
  }
}

let idleStop: IdleStop | undefined;

/** Test seam: forget the process-wide idle state. */
export function resetMateServer(): void {
  idleStop = undefined;
}

export interface MateServerLocation {
  /** Runs before an idle stop exits the process, e.g. to end registered sessions. */
  onStop: (stop: () => Promise<unknown>) => void;
  dispose: () => void;
}

/** Undefined outside a Mate OpenCode server. */
export async function registerMateServer(
  api: Context,
  env: NodeJS.ProcessEnv = process.env,
  deps: MateServerDeps = defaultDeps,
): Promise<MateServerLocation | undefined> {
  if (!runsInMateServer(env)) return undefined;
  dropPasswords(env);
  await api.shell.hook("create.before", (event) => dropPasswords(event.env));

  idleStop ??= new IdleStop(deps);
  const idle = idleStop;
  idle.start();
  const stops: Array<() => Promise<unknown>> = [];

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of api.event.subscribe({ signal: controller.signal })) {
        idle.observe(event as StepEvent);
      }
    } catch {
      /* subscription closed: the location is shutting down */
    }
  })();

  return {
    onStop: (stop) => {
      stops.push(stop);
      idle.onStop.add(stop);
    },
    dispose: () => {
      controller.abort();
      for (const stop of stops) idle.onStop.delete(stop);
    },
  };
}
