import fs from "node:fs";
import path from "node:path";

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  companionForkRefusal,
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
} from "../runtime/companion-sync";
import { hasLaunchEnvironment } from "../runtime/env";
import {
  buildArtifactError,
  extractPatchPaths,
  isArtifactPath,
  normalizeTargetPath,
  readContext,
  shouldBlockArtifactWrite,
  type CompanionContext,
} from "./companion-policy";

const REACT_DOCTOR_VERSION = "0.8.1";

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

async function runReactDoctorScan(
  context: CompanionContext,
  client: PluginInput["client"],
  $: PluginInput["$"],
  sessionID: string,
  scansInFlight: Set<string>,
): Promise<void> {
  const repo = context.repositoryPath;
  if (!repo || scansInFlight.has(sessionID)) return;
  scansInFlight.add(sessionID);
  try {
    const localBin = path.join(repo, "node_modules", ".bin", "react-doctor");
    const mateBin = process.env.MATE_REACT_DOCTOR_BIN_PATH;
    const doctorBin = mateBin && fs.existsSync(mateBin) ? mateBin : localBin;

    const result = fs.existsSync(doctorBin)
      ? await $`${doctorBin} ${REACT_DOCTOR_ARGS}`.cwd(repo).nothrow().quiet()
      : await $`npx --yes ${`react-doctor@${REACT_DOCTOR_VERSION}`} ${REACT_DOCTOR_ARGS}`
          .cwd(repo)
          .nothrow()
          .quiet();

    if (result.exitCode === 0) return;

    const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
    if (!output || REACT_DOCTOR_NON_LINT_FAILURES.some((re) => re.test(output))) return;

    await client.tui
      .showToast({
        query: { directory: repo },
        body: {
          title: "React Doctor",
          message: "Found issues in the changed files — review before finishing.",
          variant: "warning",
        },
      })
      .catch(() => {});
    await client.session
      .promptAsync({
        path: { id: sessionID },
        query: { directory: repo },
        body: {
          parts: [
            {
              type: "text",
              synthetic: true,
              text:
                "React Doctor found issues in the changed files. Review this output and fix " +
                "the regressions before finishing. For confirmed issues that cannot be fixed " +
                "now, create GitHub issues with the rule, file/line, confidence, impact, and " +
                `proposed fix.\n\n${output}`,
            },
          ],
        },
      })
      .catch(() => {});
  } catch {
    // Never break the session because a diagnostic scan failed.
  } finally {
    scansInFlight.delete(sessionID);
  }
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
  client: PluginInput["client"] | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  if (!context.companionPath || hasLaunchEnvironment(env)) return [];
  if (repairedCompanions.has(context.companionPath)) return [];
  repairedCompanions.add(context.companionPath);

  const notes = unattendedSyncStalenessLines(syncCompanionUnattended(context.companionPath));
  if (notes.length === 0) return [];

  /**
   * Operator-facing only: a model told to run the command would run it
   * unattended. Delivery is best-effort in both directions — a client that
   * throws rather than rejecting must not cost the caller its notes.
   */
  try {
    await client?.tui?.showToast({
      query: { directory: context.repositoryPath },
      body: {
        title: `${context.frameworkName} companion`,
        message: notes.join("\n"),
        variant: "warning",
      },
    });
  } catch {
    /** The note survives in the persisted record and the TUI's staleness lines. */
  }
  return notes;
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
export function refuseForkedCompanionWrite(
  context: CompanionContext,
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!filePath || !isArtifactPath(filePath)) return;
  if (!normalizeTargetPath(context, filePath).startsWith(path.normalize(context.companionPath))) {
    return;
  }
  const refusal = companionForkRefusal(env, context.companionPath);
  if (refusal) throw new Error(refusal);
}

type PluginEventInput = Parameters<NonNullable<Hooks["event"]>>[0];
type ToolBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0];
type ToolBeforeOutput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[1];
type ToolAfterInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0];

export const CompanionHooksPlugin: Plugin = async (pluginInput = {} as PluginInput) => {
  const { client, $ } = pluginInput;
  const context = readContext();
  if (!context.companionPath || !context.repositoryPath) return {};

  /**
   * The repair sits above the returned hooks, so anything escaping it would
   * cost the session every guardrail below — the artifact guard, the React
   * Doctor scan — to save a synchronization that is optional by design.
   */
  await repairCompanionGitOnce(context, client).catch(() => []);

  const dirtyReactDoctorSessions = new Set<string>();
  const reactDoctorScansInFlight = new Set<string>();

  return {
    event: async ({ event }: PluginEventInput) => {
      if (event.type !== "session.idle") return;
      const sessionID = event.properties.sessionID;
      if (
        !context.reactDoctorEnabled ||
        reactDoctorScansInFlight.has(sessionID) ||
        !dirtyReactDoctorSessions.delete(sessionID)
      ) {
        return;
      }
      await runReactDoctorScan(context, client, $, sessionID, reactDoctorScansInFlight);
    },
    "tool.execute.before": async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      const toolName = String(input.tool ?? "");
      const args = output.args ?? {};
      if (["write", "edit"].includes(toolName)) {
        const filePath = String(args.filePath ?? "");
        if (filePath && shouldBlockArtifactWrite(context, filePath)) {
          throw new Error(buildArtifactError(context, filePath));
        }
        refuseForkedCompanionWrite(context, filePath);
      }
      if (toolName === "apply_patch") {
        for (const filePath of extractPatchPaths(String(args.patchText ?? ""))) {
          if (shouldBlockArtifactWrite(context, filePath)) {
            throw new Error(buildArtifactError(context, filePath));
          }
          refuseForkedCompanionWrite(context, filePath);
        }
      }
    },
    "tool.execute.after": async (input: ToolAfterInput) => {
      if (context.reactDoctorEnabled && REACT_DOCTOR_EDIT_TOOLS.has(input.tool)) {
        dirtyReactDoctorSessions.add(input.sessionID);
      }
    },
  };
};

export default CompanionHooksPlugin;
