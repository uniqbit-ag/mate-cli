/**
 * The turn hook in Claude Code: notes the Delivery Path step a turn starts and each
 * `mate workflow done` the session runs, and at `Stop` acts on the turn's verdict: sends the
 * session back once, or shows the hand-off. Each event is its own process, so the turn is kept
 * in a private state file between them.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  defaultMateBin,
  spawnNextHandoff,
  type NextHandoff,
} from "../runtime/workflow/next-handoff-process";
import {
  finishTurn,
  hasNotes,
  noteRecorded,
  noteShell,
  noteSkill,
  startTurn,
  turnHooksEnabled,
  type Step,
  type Turn,
  type TurnVerdict,
} from "../runtime/workflow/turn";
import { hasLaunchEnvironment } from "../runtime/env";
import { record, text } from "../runtime/json-fields";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { resolveProjection } from "../runtime/projection";
import { mateHome } from "../runtime/runtime-directory";
import {
  appendTurnNote,
  privateTurnDir,
  sessionFileName,
  turnStateDir,
} from "../runtime/turn-state.mjs";
import { hookFolder, hookOutcome, runHook, type HookEnv, type HookOutcome } from "./hook-io";

export interface TurnDeps {
  /** Where turn state is kept; a private `<mate home>/turn-hooks` by default. */
  stateDir?: string;
  /** The Session Companion for the hook's folder; from the launch environment by default. */
  resolveCompanion?: (folder: string) => Promise<string>;
  /** `mate workflow next` through the runtime launcher by default. */
  nextHandoff?: NextHandoff;
}

/**
 * The state file: under Mate's home by default, not a shared tmpdir another user could create
 * first; its folder created private, and refused unless it is a directory this user owns that no
 * one else can enter. The Claude plugin's shim and `mate workflow done` use the same folder.
 */
async function stateFile(deps: TurnDeps, session: string): Promise<string> {
  const dir = deps.stateDir ?? (await privateTurnDir(turnStateDir(mateHome())));
  return path.join(dir, sessionFileName(session));
}

function asStep(value: unknown): Step | undefined {
  const { skill, change } = record(value);
  return typeof skill === "string" && typeof change === "string" ? { skill, change } : undefined;
}

/**
 * The turn noted in `file`, one JSON note per line: a later step replaces an earlier one, and
 * `recorded` notes are those `mate workflow done` appended.
 */
async function readState(file: string): Promise<Turn> {
  const content = await fs.readFile(file, "utf8").catch(() => "");
  let step: Step | undefined;
  const reports: Step[] = [];
  const recorded: unknown[] = [];
  for (const line of content.split("\n")) {
    let note: Record<string, unknown>;
    try {
      note = record(JSON.parse(line));
    } catch {
      continue;
    }
    step = asStep(note.step) ?? step;
    if (Array.isArray(note.recorded)) recorded.push(...note.recorded);
    if (!Array.isArray(note.reports)) continue;
    for (const report of note.reports.map(asStep)) if (report) reports.push(report);
  }
  return noteRecorded({ ...(step ? { step } : {}), reports }, recorded);
}

/** Written beside the file and renamed over it, which replaces a planted link, never follows it. */
async function writeState(file: string, state: Turn): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}

/** The text of the turn's last response: assistant text after the last user entry. */
async function lastResponse(input: Record<string, unknown>): Promise<string> {
  const direct = text(input.last_assistant_message);
  if (direct) return direct;
  const transcript = text(input.transcript_path);
  if (!transcript) return "";
  const lines = (await fs.readFile(transcript, "utf8").catch(() => "")).split("\n");
  let parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry.type === "user") parts = [];
    if (entry.type !== "assistant") continue;
    const content = record(entry.message).content;
    for (const block of Array.isArray(content) ? content : []) {
      const item = record(block);
      if (item.type === "text") parts.push(text(item.text));
    }
  }
  return parts.join("\n");
}

/** The launch's companion, else a wrapped repository's projected one; throws without either. */
async function defaultResolveCompanion(env: HookEnv, folder: string): Promise<string> {
  const companion = env.MATE_ARTIFACT_PATH || resolveProjection(folder)?.companionPath;
  if (!companion) throw new Error("no Session Companion");
  return companion;
}

/** The Claude Code `Stop` output for a verdict. */
function stopOutcome(verdict: TurnVerdict): HookOutcome {
  if (verdict.kind === "notice") return hookOutcome({ systemMessage: verdict.text });
  if (verdict.kind === "sendBack")
    return hookOutcome({ decision: "block", reason: verdict.reason });
  return hookOutcome(null);
}

/** One hook event; never throws past `runHook`, which turns a failure into no output. */
export async function handleTurnEvent(
  payload: unknown,
  env: HookEnv,
  cwd: string,
  deps: TurnDeps = {},
): Promise<HookOutcome> {
  if (!turnHooksEnabled(env)) return hookOutcome(null);
  const input = record(payload);
  const session = text(input.session_id);
  if (!session) return hookOutcome(null);
  const file = await stateFile(deps, session);

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      const turn = startTurn(text(input.prompt));
      // A turn that starts no step needs no file until it reports one.
      if (turn.step) await writeState(file, turn);
      else await fs.rm(file, { force: true });
      return hookOutcome(null);
    }
    case "PostToolUse": {
      const tool = record(input.tool_input);
      const empty: Turn = { reports: [] };
      if (input.tool_name === "Skill") {
        const skill = text(tool.skill).split(":").at(-1) ?? "";
        const change = text(tool.args).trim().split(/\s+/)[0] ?? "";
        const { step } = noteSkill(empty, skill, change);
        if (step) await appendTurnNote(file, { step });
      } else if (input.tool_name === "Bash") {
        const { reports } = noteShell(empty, text(tool.command));
        if (reports.length > 0) await appendTurnNote(file, { reports });
      }
      return hookOutcome(null);
    }
    case "Stop": {
      const state = await readState(file);
      // Nothing noted: no companion to resolve.
      if (!hasNotes(state)) {
        await fs.rm(file, { force: true });
        return hookOutcome(null);
      }
      const folder = hookFolder(input, env, cwd);
      const companionPath = await (
        deps.resolveCompanion ?? ((at: string) => defaultResolveCompanion(env, at))
      )(folder);
      const fetch = deps.nextHandoff ?? spawnNextHandoff(defaultMateBin(env), env);
      const verdict = await finishTurn(state, {
        companionPath,
        again: input.stop_hook_active === true,
        runtime: "claude",
        response: () => lastResponse(input),
        fetchHandoff: async (query) => fetch(query.change, folder, query.after),
      });
      // A turn not sent back is over; the next prompt starts afresh either way.
      if (verdict.kind !== "sendBack") await fs.rm(file, { force: true });
      return stopOutcome(verdict);
    }
    default:
      return hookOutcome(null);
  }
}

/**
 * Plugin-shim entry; emits nothing when it fails. A wrap's copy, marked `--projected`, yields to
 * the plugin's under a launch, so a managed session runs one. `payload`: what the shim already
 * read from stdin.
 */
export function run(
  argv: readonly string[] = process.argv.slice(2),
  payload?: unknown,
): Promise<number> {
  return runHook(
    (input) =>
      argv.includes(PROJECTED_FLAG) && hasLaunchEnvironment(process.env)
        ? Promise.resolve(hookOutcome(null))
        : handleTurnEvent(input, process.env, process.cwd()),
    () => hookOutcome(null),
    payload === undefined ? undefined : () => Promise.resolve(payload),
  );
}
