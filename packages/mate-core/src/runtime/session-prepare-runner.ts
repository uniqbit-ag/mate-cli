import { spawn } from "node:child_process";

/**
 * Client side of `mate session prepare`, shared by the OpenCode plugin and the
 * Claude session-prepare hook: spawned through the runtime-directory launcher,
 * so a crash or stale module never reaches the session that asked.
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

/** A guard against a hung local phase; it contains no network work. */
export const PREPARE_TIMEOUT_MS = 30_000;

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

/** `stdio` is the caller's, so `spawn` still types the pipes it asked for. */
function prepareSpawn(mateBin: string, repoPath: string, sync: boolean) {
  const invocation = launcherInvocation(mateBin, [
    "session",
    "prepare",
    "--repo",
    repoPath,
    "--json",
    ...(sync ? ["--sync"] : []),
  ]);
  const options = {
    cwd: repoPath,
    shell: false,
    detached: sync,
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
  };
  return { command: invocation.command, args: invocation.args, options };
}

/**
 * Spawns `mate session prepare` through the runtime-directory launcher. The
 * sync is detached so it outlives a closing location: a pull must not be cut
 * off, and the companion lock stays held until its Git work ends.
 */
export function spawnPrepareRunner(mateBin: string, repoPath: string): PrepareRunner {
  return ({ sync, timeoutMs }) =>
    new Promise((resolve) => {
      const { command, args, options } = prepareSpawn(mateBin, repoPath, sync);
      const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
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
          : setTimeout(() => {
              /** Released, not killed, so a caller about to exit does not wait on it. */
              child.unref();
              for (const stream of [child.stdout, child.stderr]) {
                (stream as unknown as { unref?: () => void }).unref?.();
              }
              settle({ ok: false, notes: [`timed out after ${timeoutMs / 1000}s`] });
            }, timeoutMs);
      child.once("error", (error) =>
        settle({ ok: false, notes: [`cannot run ${mateBin}: ${error.message}`] }),
      );
      child.once("close", (code) => {
        const run = parsePrepareOutput(stdout, code);
        settle(run.ok || stdout.trim() ? run : { ok: false, notes: [...run.notes, stderr.trim()] });
      });
    });
}

/**
 * The `--sync` variant for a caller about to exit: detached and unref'd with no
 * pipes, so the caller's exit neither waits on it nor cuts its Git work short.
 */
export function startDetachedPrepareSync(mateBin: string, repoPath: string): void {
  const { command, args, options } = prepareSpawn(mateBin, repoPath, true);
  const child = spawn(command, args, { ...options, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}
