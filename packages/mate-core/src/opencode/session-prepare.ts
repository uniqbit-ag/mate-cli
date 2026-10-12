import { spawn } from "node:child_process";

import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";

import { recordSessionNotes, type SessionNotePhase } from "./session-notes";

/**
 * Plugin side of `mate session prepare`: a bare OpenCode session in a wrapped
 * repo gets a managed launch's local prepare, then a background Git sync.
 * Spawned, so a crash or stale module never reaches the shared service.
 */

export interface PrepareRun {
  ok: boolean;
  /** Failed or warned steps, already worded for the operator. */
  notes: string[];
  /** The sync fast-forwarded the companion and re-projected it. */
  changed?: boolean;
}

export interface PrepareRequest {
  /** `--sync`: fast-forward the companion, re-project when it moved. */
  sync: boolean;
  /** Stop waiting after this long; the prepare itself is never terminated. */
  timeoutMs?: number;
}

export type PrepareRunner = (request: PrepareRequest) => Promise<PrepareRun>;

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

/** A guard against a hung local phase; it contains no network work. */
export const PREPARE_TIMEOUT_MS = 30_000;
const PREPARE_DEBOUNCE_MS = 5_000;

/** Keyed by companion: several repositories, and several locations, share one companion. */
const lastSynced = new Map<string, number>();

/** Test seam: the debounce is process-wide. */
export function resetPrepareDebounce(): void {
  lastSynced.clear();
}

interface PrepareJson {
  ok?: boolean;
  steps?: Array<{ step?: string; outcome?: string; detail?: string }>;
  warnings?: string[];
  companionChanged?: boolean;
}

export function parsePrepareOutput(stdout: string, exitCode: number | null): PrepareRun {
  let parsed: PrepareJson | null = null;
  try {
    parsed = JSON.parse(stdout) as PrepareJson;
  } catch {
    /* not JSON: the command failed before it could report */
  }
  if (!parsed) {
    const tail = stdout.trim().split("\n").slice(-3).join(" ");
    return { ok: false, notes: [`exited ${exitCode ?? "abnormally"}${tail ? `: ${tail}` : ""}`] };
  }
  const notes = [
    ...(parsed.steps ?? [])
      .filter((step) => step.outcome === "failed")
      .map((step) => `${step.step}: ${step.detail ?? "failed"}`),
    ...(parsed.warnings ?? []),
  ];
  const changed = parsed.companionChanged === true;
  return { ok: parsed.ok === true && exitCode === 0, notes, ...(changed ? { changed } : {}) };
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/**
 * How to run the runtime launcher without a shell, so a path with spaces stays
 * one argument. Windows cannot execute the `.cmd` launcher directly, so it goes
 * through `cmd.exe` with the line quoted here rather than by a shell.
 */
export function launcherInvocation(
  mateBin: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32") return { command: mateBin, args: [...args], verbatim: false };
  const line = [mateBin, ...args].map(quoteForCmd).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * Spawns `mate session prepare` through the runtime-directory launcher. The
 * sync is detached so it outlives a closing location: a pull must not be cut
 * off, and the companion lock stays held until its Git work ends.
 */
export function spawnPrepareRunner(mateBin: string, repoPath: string): PrepareRunner {
  return ({ sync, timeoutMs }) =>
    new Promise((resolve) => {
      const invocation = launcherInvocation(mateBin, [
        "session",
        "prepare",
        "--repo",
        repoPath,
        "--json",
        ...(sync ? ["--sync"] : []),
      ]);
      const child = spawn(invocation.command, invocation.args, {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: sync,
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
      });
      if (sync) child.unref();
      let settled = false;
      const settle = (run: PrepareRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(run);
      };
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => settle({ ok: false, notes: [`timed out after ${timeoutMs / 1000}s`] }),
              timeoutMs,
            );
      child.once("error", (error) =>
        settle({ ok: false, notes: [`cannot run ${mateBin}: ${error.message}`] }),
      );
      child.once("close", (code) => {
        const run = parsePrepareOutput(stdout, code);
        settle(run.ok || stdout.trim() ? run : { ok: false, notes: [...run.notes, stderr.trim()] });
      });
    });
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
