import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";

import {
  PREPARE_TIMEOUT_MS,
  type PrepareRun,
  type PrepareRunner,
} from "../runtime/session-prepare-runner";
import { recordSessionNotes, type SessionNotePhase } from "./session-notes";

/**
 * Plugin side of `mate session prepare`: a bare OpenCode session in a wrapped
 * repo gets a managed launch's local prepare, then a background Git sync.
 * Spawned, so a crash or stale module never reaches the shared service.
 */

export interface SessionPrepareOptions {
  directory: string;
  repoPath: string;
  companionPath: string;
  /** Mate-declared MCP servers; only these are held back until the local phase ends. */
  mateServers: readonly string[];
  run: PrepareRunner;
  log?: (line: string) => void;
  timeoutMs?: number;
  debounceMs?: number;
}

const PREPARE_DEBOUNCE_MS = 5_000;

/** Keyed by companion: several repositories, and several locations, share one companion. */
const lastSynced = new Map<string, number>();

/** Test seam: the debounce is process-wide. */
export function resetPrepareDebounce(): void {
  lastSynced.clear();
}

function logger(options: SessionPrepareOptions): (line: string) => void {
  return options.log ?? ((line: string) => console.error(line));
}

/** Logs the notes and records them for the TUI's toast. */
async function report(
  options: SessionPrepareOptions,
  run: PrepareRun,
  phase: SessionNotePhase,
): Promise<void> {
  const log = logger(options);
  const verdict = run.ok ? "warning" : "failed";
  for (const note of run.notes) log(`mate: session ${phase} ${verdict}: ${note}`);
  await recordSessionNotes(options.repoPath, phase, run.notes);
}

function failedRun(error: unknown): PrepareRun {
  return { ok: false, notes: [error instanceof Error ? error.message : String(error)] };
}

/** No remote: OpenCode holds MCP servers and skills until `setup` returns. */
async function prepareLocal(options: SessionPrepareOptions): Promise<void> {
  const run = await options
    .run({ sync: false, timeoutMs: options.timeoutMs ?? PREPARE_TIMEOUT_MS })
    .catch(failedRun);
  await report(options, run, "prepare");
}

/** Never awaited: the session runs on while the companion is fetched. */
function startSync(api: Context, options: SessionPrepareOptions): void {
  lastSynced.set(options.companionPath, Date.now());
  void options
    .run({ sync: true })
    .catch(failedRun)
    .then(async (run) => {
      await report(options, run, "sync");
      if (!run.changed) return;
      await api.mcp.reload().catch(() => {});
      logger(options)("mate: companion updated; MCP servers reloaded.");
    });
}

function eventDirectory(event: unknown): string | undefined {
  const record = event as {
    location?: { directory?: string };
    data?: { location?: { directory?: string } };
  };
  return record.location?.directory ?? record.data?.location?.directory;
}

/**
 * Holds the Mate MCP servers back, runs the local phase before `setup`
 * returns, releases them, then syncs the companion in the background; syncs
 * again on new sessions of this location. Neither a failed nor a slow prepare
 * keeps the session from starting, and none is ever terminated.
 */
export async function registerSessionPrepare(
  api: Context,
  options: SessionPrepareOptions,
): Promise<Cleanup> {
  const held = new Set(options.mateServers);
  let gated = held.size > 0;
  if (gated) {
    await api.mcp.transform((editor) => {
      if (!gated) return;
      for (const name of held) {
        if (editor.get(name)) {
          editor.update(name, (config) => {
            config.disabled = true;
          });
        }
      }
    });
  }

  try {
    await prepareLocal(options);
  } finally {
    if (gated) {
      gated = false;
      await api.mcp.reload().catch(() => {});
    }
  }
  startSync(api, options);

  const controller = new AbortController();
  const debounceMs = options.debounceMs ?? PREPARE_DEBOUNCE_MS;
  void (async () => {
    try {
      for await (const event of api.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.created") continue;
        if (eventDirectory(event) !== options.directory) continue;
        const last = lastSynced.get(options.companionPath) ?? 0;
        if (Date.now() - last < debounceMs) continue;
        startSync(api, options);
      }
    } catch {
      /* subscription closed: the location is shutting down */
    }
  })();
  return () => controller.abort();
}
