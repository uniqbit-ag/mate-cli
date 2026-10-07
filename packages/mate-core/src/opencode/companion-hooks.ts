import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";

import {
  companionForkRefusal,
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
} from "../runtime/companion-sync";
import { hasLaunchEnvironment } from "../runtime/env";
import { MATE_ENV } from "../runtime/env-names";
import {
  buildArtifactError,
  extractPatchPaths,
  isArtifactPath,
  normalizeTargetPath,
  shouldBlockArtifactWrite,
  type CompanionContext,
} from "./companion-policy";

const REACT_DOCTOR_VERSION = "0.9.13";

const REACT_DOCTOR_NON_LINT_FAILURES = [
  /No React dependency found/i,
  /Could not resolve config/i,
  /is not a git repository/i,
];

const REACT_DOCTOR_EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const REACT_DOCTOR_ARGS = [
  "--yes",
  "--verbose",
  "--scope",
  "changed",
  "--base",
  "HEAD",
  "--blocking",
  "warning",
  "--no-score",
  "--max-duration",
  "30",
];

export type CommandResult = { exitCode: number | null; output: string };
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;
type SessionPrompt = Pick<Context["session"], "prompt">;

/** Combined stdout and stderr; rejects only when the process cannot be spawned. */
export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, output: output.trim() }));
  });

function reactDoctorCommand(repo: string): { command: string; args: string[] } {
  const localBin = path.join(repo, "node_modules", ".bin", "react-doctor");
  const mateBin = process.env.MATE_REACT_DOCTOR_BIN_PATH;
  const doctorBin = mateBin && fs.existsSync(mateBin) ? mateBin : localBin;
  return fs.existsSync(doctorBin)
    ? { command: doctorBin, args: REACT_DOCTOR_ARGS }
    : {
        command: "npx",
        args: ["--yes", `react-doctor@${REACT_DOCTOR_VERSION}`, ...REACT_DOCTOR_ARGS],
      };
}

/**
 * Tracks edited sessions and scans each at most once per idle, never twice
 * concurrently for the same session.
 */
export function createReactDoctorScanner(
  context: CompanionContext,
  session: SessionPrompt,
  run: CommandRunner = runCommand,
) {
  const dirtySessions = new Set<string>();
  const scansInFlight = new Set<string>();

  return {
    markEdited(tool: string, sessionID: string): void {
      if (REACT_DOCTOR_EDIT_TOOLS.has(tool)) dirtySessions.add(sessionID);
    },
    async idle(sessionID: string): Promise<void> {
      const repo = context.repositoryPath;
      if (!repo || scansInFlight.has(sessionID) || !dirtySessions.delete(sessionID)) return;
      scansInFlight.add(sessionID);
      try {
        const { command, args } = reactDoctorCommand(repo);
        const { exitCode, output } = await run(command, args, repo);
        if (exitCode === 0 || !output) return;
        if (REACT_DOCTOR_NON_LINT_FAILURES.some((re) => re.test(output))) return;

        await session
          .prompt({
            sessionID,
            text:
              "React Doctor found issues in the changed files. Review this output and fix " +
              "the regressions before finishing. For confirmed issues that cannot be fixed " +
              "now, create GitHub issues with the rule, file/line, confidence, impact, and " +
              `proposed fix.\n\n${output}`,
          } as never)
          .catch(() => {});
      } catch {
        /** Never break the session because a diagnostic scan failed. */
      } finally {
        scansInFlight.delete(sessionID);
      }
    },
  };
}

/**
 * Keyed by companion so a double-loaded plugin repairs at most once per
 * session, which is the guarantee the spec asks for.
 */
const repairedCompanions = new Set<string>();

/**
 * Session start is the only point at which the companion may move without
 * invalidating a read the session has already taken. The launch-environment
 * gate comes first so a Managed Session does no Git work at all; the consent
 * gate is the operation's own.
 */
export async function repairCompanionGitOnce(
  context: CompanionContext,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  if (
    !context.companionPath ||
    (hasLaunchEnvironment(env) &&
      (env[MATE_ENV.repositoryPath] !== undefined || env[MATE_ENV.gitAutoMode] !== "1"))
  )
    return [];
  if (repairedCompanions.has(context.companionPath)) return [];
  repairedCompanions.add(context.companionPath);

  /**
   * Operator-facing only: a model told to run the command would run it
   * unattended. The V2 server API has no toast; the notes reach the operator
   * through the persisted record and the TUI's staleness lines.
   */
  return unattendedSyncStalenessLines(await syncCompanionUnattended(context.companionPath));
}

/** Test seam: the once-per-session guard is process-wide by design. */
export function resetCompanionGitRepairGuard(): void {
  repairedCompanions.clear();
}

/**
 * Writing artifacts on top of a forked companion is the state in which the
 * eventual reconciliation destroys work. The verdict comes from `runtime/`, so
 * the Claude hook and this middleware refuse the same writes for the same
 * reason — including the launch-environment gate that keeps a Managed
 * Launch's Git decision authoritative for the session it started.
 */
export async function refuseForkedCompanionWrite(
  context: CompanionContext,
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!filePath || !isArtifactPath(filePath)) return;
  if (!normalizeTargetPath(context, filePath).startsWith(path.normalize(context.companionPath))) {
    return;
  }
  const refusal = await companionForkRefusal(env, context.companionPath);
  if (refusal) throw new Error(refusal);
}

/** Rejects when the tool call would write an artifact outside the companion. */
export async function guardToolInput(
  context: CompanionContext,
  tool: string,
  input: unknown,
): Promise<void> {
  const args = (input ?? {}) as Record<string, unknown>;
  const filePaths =
    tool === "write" || tool === "edit"
      ? [String(args.filePath ?? "")]
      : tool === "apply_patch"
        ? extractPatchPaths(String(args.patchText ?? ""))
        : [];

  for (const filePath of filePaths) {
    if (context.repositoryPath && filePath && shouldBlockArtifactWrite(context, filePath)) {
      throw new Error(buildArtifactError(context, filePath));
    }
    // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
    await refuseForkedCompanionWrite(context, filePath);
  }
}

export type CompanionHooksOptions = {
  /** Test seam for the React Doctor process. */
  run?: CommandRunner;
};

/**
 * Registers the companion guardrails on an OpenCode V2 plugin context.
 * The caller resolves `context` and skips this when no companion resolved.
 */
export async function registerCompanionHooks(
  api: Context,
  context: CompanionContext,
  options: CompanionHooksOptions = {},
): Promise<Cleanup | undefined> {
  /**
   * Anything escaping the repair would cost the session every guardrail
   * below to save a synchronization that is optional by design.
   */
  await repairCompanionGitOnce(context).catch(() => []);

  await api.tool.hook("execute.before", (event) =>
    guardToolInput(context, event.tool, event.input),
  );

  if (!context.repositoryPath || !context.reactDoctorEnabled) return;

  const scanner = createReactDoctorScanner(context, api.session, options.run);
  await api.tool.hook("execute.after", (event) => {
    if (event.status === "completed") scanner.markEdited(event.tool, event.sessionID);
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of api.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.idle") await scanner.idle(event.data.sessionID);
      }
    } catch {
      /** Plugin shutdown aborts the subscription; event delivery is best effort. */
    }
  })();
  return () => controller.abort();
}
