/** `mate workflow next --json` as a child process, for the turn hooks of every runtime. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { record, text } from "../json-fields";
import { runtimeMateBin } from "../runtime-directory";
import { isInvocationChange } from "../skill-prefix";
import { launcherInvocation } from "../session-prepare-runner";
import type { PrintedHandoff } from "./turn";

/**
 * The hand-off for a change, as `mate workflow next --json [--after <skill>]` prints it in
 * `folder`; null when the change has no folder or the command fails.
 */
export type NextHandoff = (
  change: string,
  folder: string,
  after?: string,
) => PrintedHandoff | null | Promise<PrintedHandoff | null>;

/**
 * The `mate` on the session's `PATH`, the one it reports with; else the runtime-directory
 * launcher every `mate` run keeps current, for a CLI started through npx or a checkout. A relative
 * entry is skipped: it would resolve against the repository the hook runs in.
 */
export function defaultMateBin(env: Record<string, string | undefined>): string {
  const names = process.platform === "win32" ? ["mate.cmd", "mate.exe"] : ["mate"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      if (path.isAbsolute(dir) && existsSync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  const launcher = runtimeMateBin();
  return existsSync(launcher) ? launcher : "mate";
}

/**
 * `mate workflow next <change> --json [--after <skill>]` in `folder` through the launcher,
 * without a shell and without blocking: with `after`, the hand-off `mate workflow done` printed.
 * A change that is no change name, such as a flag, gets null without a run.
 */
export function spawnNextHandoff(
  mateBin: string,
  env: Record<string, string | undefined>,
): (change: string, folder: string, after?: string) => Promise<PrintedHandoff | null> {
  return (change, folder, after) =>
    new Promise((resolve) => {
      if (!isInvocationChange(change)) {
        resolve(null);
        return;
      }
      const args = ["workflow", "next", change, "--json", ...(after ? ["--after", after] : [])];
      const launch = launcherInvocation(mateBin, args);
      let stdout = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launch.command, launch.args, {
          cwd: folder,
          env: env as NodeJS.ProcessEnv,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: launch.verbatim,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 20_000,
        });
      } catch {
        resolve(null);
        return;
      }
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.once("error", () => resolve(null));
      child.once("close", (code) => resolve(code === 0 ? parseNextHandoff(stdout) : null));
    });
}

/**
 * The hand-off in `mate workflow next --json` output; null without one. An older CLI prints no
 * `actions`: the hand-off then has no skill actions to check, so the turn passes.
 */
export function parseNextHandoff(stdout: string): PrintedHandoff | null {
  // A runtime repair on the same run may print lines of its own before the JSON.
  const json = stdout.split("\n").findLast((line) => line.startsWith("{"));
  if (!json) return null;
  try {
    const parsed = record(JSON.parse(json));
    const handoff = text(parsed.handoff);
    if (parsed.ok !== true || !handoff) return null;
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).flatMap((entry) => {
      const { kind, skill, change } = record(entry);
      // A skill that takes no change, such as publish, keeps an empty one.
      return kind === "skill" && text(skill) ? [{ skill: text(skill), change: text(change) }] : [];
    });
    return { handoff, actions };
  } catch {
    return null;
  }
}
