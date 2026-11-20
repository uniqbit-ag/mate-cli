import fs from "node:fs/promises";
import path from "node:path";

import { activeChanges, isChangeName, locateChange } from "../../../lib/change-layout";
import { recordStep } from "../../../lib/delivery/record";
import { sourceDir } from "../../../lib/delivery/staging/artifact-type";
import { submitArtifactType } from "../../../lib/delivery/staging/registry";
import { pathIsDirectory } from "../../../lib/fs-utils";
import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { RepositoryNotFoundError } from "../../../lib/orchestrator/types";
import {
  BUILTIN_ARTIFACT_TYPE,
  loadWorkflow,
  nextStage,
  WORKFLOW_FILE,
  type NextStage,
  type Workflow,
  type WorkflowProblem,
  type WorkflowSkillStage,
  type WorkflowSource,
  type WorkflowStep,
} from "../../../lib/workflow/declaration";
import { readChangeInput } from "../../../lib/workflow/change-progress";
import {
  handoffLines,
  renderHandoff,
  type HandoffAction,
  type SkillAction,
} from "../../../lib/workflow/handoff";
import { opensPath, pathPosition, recordedSteps, stepStage } from "../../../lib/workflow/position";
import { errorMessage } from "../../../runtime/error-message";
import { FRAMEWORK_NAME } from "../../../runtime/framework";
import { agentRuntime } from "../../../runtime/skill-prefix";
import { type BooleanFlagSet, parseFlags, positionalArgs, stringFlag } from "../../parse-flags";
import { usage } from "../../usage";
import { commandOutput, type CommandOutput } from "../artifact/delivery/output";

export interface WorkflowCommandDeps {
  /** The Session Companion's path; resolved from the launch environment by default. */
  resolveCompanion?: (cwd: string) => Promise<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Names the Agent Runtime whose skill syntax a hand-off uses; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

const BOOLEAN_FLAGS: BooleanFlagSet = new Set(["json"]);

/** What `mate workflow steps <stage> --json` prints for a resolved stage. */
export interface StageSteps {
  ok: true;
  stage: string;
  /** Whether the companion declared the chain or it is the built-in default. */
  source: WorkflowSource;
  /** The declaration's companion-relative path; null when the companion has none. */
  file: string | null;
  steps: WorkflowStep[];
  /** The skill the stage is entered through. */
  entry: string;
  /** For `submit`: the type it handles, a declared one or `openspec`. */
  artifact?: string;
  next: NextStage | null;
  warnings: string[];
}

/** What both subcommands print with `--json` when they refuse. */
export interface WorkflowFailure {
  ok: false;
  file: string;
  problems: WorkflowProblem[];
}

async function defaultResolveCompanion(cwd: string): Promise<string> {
  return (await resolveFrameworkContext(cwd, undefined, { write: false })).companionPath;
}

interface Run extends CommandOutput {
  json: boolean;
}

/** Exit 1: every problem on stderr, and with `--json` the failure alone on stdout. */
function fail(run: Run, problems: WorkflowProblem[]): void {
  for (const problem of problems) {
    run.emitErr(`mate: ${problem.path ? `${problem.path}: ` : ""}${problem.message}`);
  }
  if (run.json) {
    run.emitOut(
      JSON.stringify({ ok: false, file: WORKFLOW_FILE, problems } satisfies WorkflowFailure),
    );
  }
  process.exitCode = 1;
}

/** The companion's valid workflow, or null after the failure was reported. */
async function resolveWorkflow(
  run: Run,
  deps: WorkflowCommandDeps,
): Promise<{
  companionPath: string;
  workflow: Workflow;
} | null> {
  let companionPath: string;
  try {
    companionPath = await (deps.resolveCompanion ?? defaultResolveCompanion)(process.cwd());
  } catch (error) {
    if (!(error instanceof RepositoryNotFoundError)) throw error;
    fail(run, [{ path: "", message: error.message }]);
    return null;
  }
  const verdict = await loadWorkflow(companionPath);
  if (!verdict.ok) {
    run.emitErr(`mate: ${WORKFLOW_FILE} is invalid; fix it, then run the stage again.`);
    fail(run, verdict.problems);
    return null;
  }
  return { companionPath, workflow: verdict.workflow };
}

/** The skill stage `id`, or null after an unknown or review stage was reported. */
function skillStage(
  run: Run,
  workflow: Workflow,
  id: string | undefined,
): WorkflowSkillStage | null {
  const stage = workflow.stages.find((entry) => entry.id === id);
  if (stage?.kind === "skill") return stage;
  const names = workflow.stages.filter((entry) => entry.kind === "skill").map((entry) => entry.id);
  const what =
    id === undefined
      ? "a stage is required"
      : stage
        ? `${id} is a review stage`
        : `unknown stage ${id}`;
  fail(run, [{ path: "", message: `${what}; the skill stages are ${names.join(", ")}.` }]);
  return null;
}

function renderSteps(result: StageSteps): string[] {
  const origin = result.source === "declared" ? `declared in ${result.file}` : "default";
  const next = result.next
    ? result.next.kind === "skill"
      ? `${result.next.id} (${result.next.entry})`
      : `${result.next.id} (human review)`
    : "none";
  return [
    `${result.stage} (${origin})`,
    ...result.steps.map(
      (step, index) => `  ${index + 1}. ${step.skill}${step.own ? " (the stage's own work)" : ""}`,
    ),
    `  entry: ${result.entry}`,
    ...(result.artifact === undefined ? [] : [`  artifact: ${result.artifact}`]),
    `  next: ${next}`,
  ];
}

/**
 * @command mate workflow steps <stage>
 * @description Resolves one skill stage of the Session Companion's Delivery Path from
 * `.mate/config/workflow.yaml`, or from the built-in default without one: its steps in order,
 * the skill it is entered through, and the stage it hands off to. Writes nothing.
 * @flags
 * - `--json` — emit a {@link StageSteps}: `ok`, `stage`, `source` (`declared` or `default`),
 *   `file`, `steps` (each `skill`, with `own: true` for the stage's Mate stage skill), `entry`,
 *   `artifact` (for `submit`), `next` and `warnings`.
 * @remarks Exits 1 on an invalid declaration, an unknown stage or a review stage, with every
 * problem on stderr and, with `--json`, `ok: false` and `problems` on stdout. Never falls back
 * to the default steps. A declared skill missing from the companion's skills is a warning.
 */
async function runSteps(argv: string[], run: Run, deps: WorkflowCommandDeps): Promise<void> {
  const [id] = positionalArgs(argv, BOOLEAN_FLAGS);
  const resolved = await resolveWorkflow(run, deps);
  if (!resolved) return;
  const { workflow } = resolved;
  const stage = skillStage(run, workflow, id);
  if (!stage) return;
  const result: StageSteps = {
    ok: true,
    stage: stage.id,
    source: stage.source,
    file: workflow.file,
    steps: stage.steps,
    entry: stage.entry,
    ...(stage.id === "submit" ? { artifact: workflow.submitArtifact } : {}),
    next: nextStage(workflow, stage.id),
    warnings: workflow.warnings,
  };
  for (const warning of workflow.warnings) run.emitErr(`warning: ${warning}`);
  if (run.json) run.emitOut(JSON.stringify(result));
  else for (const line of renderSteps(result)) run.emitOut(line);
}

/** The names of the changes of the type submit handles that have a folder. */
async function existingChanges(companionPath: string, workflow: Workflow): Promise<string[]> {
  if (workflow.submitArtifact === BUILTIN_ARTIFACT_TYPE) return activeChanges(companionPath);
  const root = path.dirname(sourceDir(companionPath, submitArtifactType(workflow), "_"));
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * The change's folder; else the problem naming the path it is expected at and the changes that
 * do exist, so the next call can correct the name.
 */
async function changeFolder(
  companionPath: string,
  workflow: Workflow,
  change: string,
): Promise<{ dir: string } | { problem: WorkflowProblem }> {
  let missing: string;
  if (workflow.submitArtifact === BUILTIN_ARTIFACT_TYPE) {
    const location = await locateChange(companionPath, change);
    if (location && !location.archived) return { dir: location.dir };
    missing = `openspec/changes/${change}/`;
  } else {
    const type = submitArtifactType(workflow);
    const dir = sourceDir(companionPath, type, change);
    if (await pathIsDirectory(dir)) return { dir };
    missing = `${type.source}/${change}/`;
  }
  const existing = (await existingChanges(companionPath, workflow)).toSorted();
  const known =
    existing.length > 0 ? `; the changes are ${existing.join(", ")}` : "; there are no changes";
  return {
    problem: { path: "", message: `${change} has no change folder at ${missing}${known}.` },
  };
}

/** What `mate workflow done --json` prints for a reported step. */
export interface StepDone {
  ok: true;
  stage: string;
  /** Null without a change. */
  change: string | null;
  step: string;
  /** False for a step whose end the change's state or its publication records. */
  recorded: boolean;
  /** The stage's steps not done, in chain order. */
  remaining: string[];
  /**
   * The change's steps that count as done without a report, by stage id: a later step is
   * recorded. The hand-off names them above its section and lists none as an action.
   */
  counted: Record<string, string[]>;
  complete: boolean;
  /**
   * The `## Next steps` section to end the response with: the next step of the stage, or the
   * stage the change is then at. The developer starts what it names; a session runs none of it.
   */
  handoff?: string;
  /** The section's actions in order, skill names without a prefix; empty when nothing follows. */
  actions: HandoffAction[];
  /** The optional skill stages offered beside them. */
  optional: SkillAction[];
}

/** Each skill stage with its steps, for a refusal that names what to run instead. */
function stepsOf(workflow: Workflow): string {
  return workflow.stages
    .flatMap((stage) =>
      stage.kind === "skill"
        ? [`${stage.id} (${stage.steps.map((step) => step.skill).join(", ")})`]
        : [],
    )
    .join("; ");
}

/**
 * @command mate workflow done <skill> [<change>]
 * @description Reports that the step `<skill>` finished for a change and says what comes next.
 * The skill names its stage, since a skill is one step of the Delivery Path. Appends the skill
 * to `stages.<stage>` in the change's `delivery.yaml`, changing nothing else in it; the change is
 * the folder of the artifact type submit handles. Always prints the next actions as bare data,
 * one `next:` line each in order, then one `optional:` line: the next step of the stage, or the
 * stage the change is then at. The calling skill writes them into its `## Next steps` section;
 * the developer starts what it names, and no step runs by itself.
 * @flags
 * - `--json` — emit a {@link StepDone}: `ok`, `stage`, `change`, `step`, `recorded`,
 *   `remaining`, `counted`, `complete`, `handoff`, `actions` and `optional`.
 * @remarks Without `<change>`, or up to the path's first required stage with one that has no
 * folder yet, records nothing and hands off to the stage after it, named for the change when
 * given. Past that stage, where the change should exist, a missing folder exits 1, naming the
 * expected path and the changes that exist, so a mistyped name is corrected. A step whose
 * earlier steps are not recorded is still recorded, and those steps count as done: `counted`
 * names them by stage, and the hand-off names them in a `Counted, not reported:` line above its
 * section, never as an action. Exits 1, writing nothing, on an invalid declaration or a skill
 * that is no step (naming each stage's steps). An optional stage, `publish`, and `mate-submit-change` and the steps after it in
 * `submit`, record nothing (`recorded: false`). A step already recorded changes nothing. After
 * `publish` nothing is printed.
 */
async function runDone(argv: string[], run: Run, deps: WorkflowCommandDeps): Promise<void> {
  const [skill, name, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (skill === undefined || extra.length > 0 || (name !== undefined && !isChangeName(name))) {
    const what =
      skill === undefined ? "a step's skill is required" : "it takes a skill and one change name";
    const message = `workflow done: ${what}: ${FRAMEWORK_NAME} workflow done <skill> [<change>].`;
    return fail(run, [{ path: "", message }]);
  }
  const resolved = await resolveWorkflow(run, deps);
  if (!resolved) return;
  const { companionPath, workflow } = resolved;
  const stage = stepStage(workflow, skill);
  if (!stage) {
    const message = `${skill} is no step of the Delivery Path; the steps are ${stepsOf(workflow)}.`;
    return fail(run, [{ path: "", message }]);
  }
  const steps = stage.steps.map((step) => step.skill);
  const index = steps.indexOf(skill);

  let dir: string | null = null;
  // After publication the change is archived, so `publish` needs no folder.
  if (name && stage.id !== "publish") {
    const folder = await changeFolder(companionPath, workflow, name);
    // Before the change exists only its stage's hand-off holds; after, a missing one is a typo.
    if (!("problem" in folder)) dir = folder.dir;
    else if (!opensPath(workflow, stage)) return fail(run, [folder.problem]);
  }
  // An optional stage records nothing: no change waits for it, and the record stays about the
  // stages that count.
  const recorded = Boolean(name && dir !== null && index < recordedSteps(stage).length);
  try {
    if (recorded) await recordStep(dir!, name!, stage.id, skill);
    const input =
      name && dir !== null ? await readChangeInput(companionPath, workflow, dir, name) : null;
    const { handoff, openSteps, counted } = pathPosition(
      workflow,
      input?.progress ?? null,
      input?.subject ?? (name ? { name } : {}),
      skill,
    );
    // A stage that records nothing has only the chain's order to go by.
    const open = recorded && input ? (openSteps[stage.id] ?? []) : steps.slice(index + 1);
    const result: StepDone = {
      ok: true,
      stage: stage.id,
      change: name ?? null,
      step: skill,
      recorded,
      remaining: open,
      counted,
      complete: open.length === 0,
      actions: handoff.actions,
      optional: handoff.optional,
    };
    const runtime = agentRuntime(deps.env ?? process.env);
    const section = renderHandoff(handoff, runtime);
    if (section) result.handoff = section;
    if (run.json) return run.emitOut(JSON.stringify(result));
    for (const line of handoffLines(handoff, runtime)) run.emitOut(line);
  } catch (error) {
    // A Delivery Record that cannot be read.
    fail(run, [{ path: "", message: errorMessage(error) }]);
  }
}

/** What `mate workflow next --json` prints. */
export interface ChangeNext {
  ok: true;
  change: string;
  /** The stage the change is at; null for a dropped change. */
  stage: string | null;
  /** What keeps that stage from being done, in a few words; null when nothing does. */
  open: string | null;
  /** The `## Next steps` section; empty when nothing follows. */
  handoff: string;
  /** Its actions, as `mate workflow done --json` prints them. */
  actions: HandoffAction[];
  optional: SkillAction[];
}

/**
 * @command mate workflow next <change>
 * @description Prints the stage a change is at and its next actions as a `## Next steps`
 * section, writing nothing: the hand-off `mate workflow done` would print, computed from the
 * declaration, the change's Delivery Record and its tasks alone, whatever a session wrote.
 * @flags
 * - `--json` — emit a {@link ChangeNext}: `ok`, `change`, `stage`, `open`, `handoff`,
 *   `actions` and `optional`.
 * - `--after <skill>` — the hand-off `mate workflow done <skill> <change>` printed instead, which
 *   for a step that records nothing follows the stage's chain; the turn hook checks against it.
 * @remarks Exits 1 on an invalid declaration, a change whose folder does not exist, naming the
 * expected path and the changes that exist, or an `--after` skill that is no step.
 */
async function runNext(argv: string[], run: Run, deps: WorkflowCommandDeps): Promise<void> {
  const [name, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  const after = stringFlag(parseFlags(argv, BOOLEAN_FLAGS).after);
  if (name === undefined || extra.length > 0 || !isChangeName(name)) {
    const message = `workflow next takes one change name: ${FRAMEWORK_NAME} workflow next <change> [--after <skill>].`;
    return fail(run, [{ path: "", message }]);
  }
  const resolved = await resolveWorkflow(run, deps);
  if (!resolved) return;
  const { companionPath, workflow } = resolved;
  if (after !== undefined && !stepStage(workflow, after)) {
    const message = `${after} is no step of the Delivery Path; the steps are ${stepsOf(workflow)}.`;
    return fail(run, [{ path: "", message }]);
  }
  const folder = await changeFolder(companionPath, workflow, name);
  if ("problem" in folder) return fail(run, [folder.problem]);
  try {
    const { progress, subject } = await readChangeInput(companionPath, workflow, folder.dir, name);
    const { stage: position, open, handoff } = pathPosition(workflow, progress, subject, after);
    const result: ChangeNext = {
      ok: true,
      change: name,
      stage: position?.id ?? null,
      open,
      handoff: renderHandoff(handoff, agentRuntime(deps.env ?? process.env)),
      actions: handoff.actions,
      optional: handoff.optional,
    };
    if (run.json) return run.emitOut(JSON.stringify(result));
    run.emitOut(
      position
        ? `${name} is at ${position.label}${open ? ` (${open})` : ""}.`
        : `${name} is dropped.`,
    );
    if (result.handoff) {
      run.emitOut("");
      for (const line of result.handoff.split("\n")) run.emitOut(line);
    }
  } catch (error) {
    // A Delivery Record that cannot be read.
    fail(run, [{ path: "", message: errorMessage(error) }]);
  }
}

const HELP = new Set(["help", "--help", "-h"]);

/** The usage lines of `mate workflow`'s subcommands. */
function workflowUsage(): string {
  const prefix = ` ${FRAMEWORK_NAME} workflow `;
  return [
    "Usage:",
    ...usage()
      .split("\n")
      .filter((line) => line.startsWith(prefix)),
  ].join("\n");
}

/**
 * @command mate workflow <subcommand>
 * @description Dispatches to `steps`, `done` and `next`. `--help` (also after a subcommand) prints
 * the workflow usage. Prints it and sets a non-zero exit code for an unrecognized subcommand.
 */
export async function runWorkflowCommand(
  subcommand: string | undefined,
  argv: string[],
  deps: WorkflowCommandDeps = {},
): Promise<void> {
  const run: Run = { ...commandOutput(deps), json: parseFlags(argv, BOOLEAN_FLAGS).json === true };
  if (
    (subcommand && HELP.has(subcommand)) ||
    argv.some((arg) => arg === "--help" || arg === "-h")
  ) {
    run.emitOut(workflowUsage());
    return;
  }
  switch (subcommand) {
    case "steps":
      await runSteps(argv, run, deps);
      return;
    case "done":
      await runDone(argv, run, deps);
      return;
    case "next":
      await runNext(argv, run, deps);
      return;
    default:
      run.emitErr(`Unknown workflow command: ${subcommand ?? ""}`);
      run.emitErr(workflowUsage());
      process.exitCode = 1;
  }
}
