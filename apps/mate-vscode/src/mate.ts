import { execFile } from "node:child_process";

import type { PendingJson } from "./pending";
import type { Runtime, Session } from "./sessions";

/** Runs `mate` through the user's login shell: GUI-started editors lack version-manager PATH entries. */

export class MateNotFoundError extends Error {
  constructor() {
    super(
      "`mate` was not found on your login shell PATH. Install Mate, then run `mate vscode setup`.",
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (command: string, cwd: string) => Promise<ShellResult>;

const loginShell: ShellRunner = (command, cwd) =>
  new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    execFile(
      shell,
      ["-lc", command],
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** Exit 127 is the shell's "command not found". */
export async function runMateJson<T>(
  args: string[],
  cwd: string,
  run: ShellRunner = loginShell,
): Promise<T> {
  const result = await run(["mate", ...args.map(shellQuote)].join(" "), cwd);
  if (result.code === 127) throw new MateNotFoundError();
  if (result.code !== 0) {
    const message = result.stderr.trim().split("\n").findLast(Boolean);
    throw new Error(message ?? `mate ${args[0]} exited with code ${result.code}`);
  }
  // A login profile may print before the JSON document.
  const start = result.stdout.indexOf("{");
  return JSON.parse(start < 0 ? result.stdout : result.stdout.slice(start)) as T;
}

export async function listSessions(cwd: string, run?: ShellRunner): Promise<Session[]> {
  const result = await runMateJson<{ sessions: Session[] }>(
    ["session", "list", "--json"],
    cwd,
    run,
  );
  return result.sessions;
}

export function addSession(
  session: { id: string; runtime: Runtime; cwd: string },
  run?: ShellRunner,
): Promise<Session> {
  return runMateJson<Session>(
    [
      "session",
      "add",
      "--runtime",
      session.runtime,
      "--id",
      session.id,
      "--cwd",
      session.cwd,
      "--json",
    ],
    session.cwd,
    run,
  );
}

export async function removeSession(id: string, cwd: string, run?: ShellRunner): Promise<void> {
  await runMateJson(["session", "remove", id, "--json"], cwd, run);
}

export function pendingArtifacts(cwd: string, run?: ShellRunner): Promise<PendingJson> {
  return runMateJson<PendingJson>(["artifact", "pending", "--json"], cwd, run);
}
