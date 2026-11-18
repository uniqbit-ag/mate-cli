import { isChangeName, locateChange } from "../../../lib/change-layout";
import { recordStageDone } from "../../../lib/delivery/record";
import { sourceDir } from "../../../lib/delivery/staging/artifact-type";
import { submitArtifactType } from "../../../lib/delivery/staging/registry";
import { pathIsDirectory } from "../../../lib/fs-utils";
import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { RepositoryNotFoundError } from "../../../lib/orchestrator/types";
import {
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
import { type BooleanFlagSet, parseFlags, positionalArgs } from "../../parse-flags";
import { usage } from "../../usage";
import { commandOutput, type CommandOutput } from "../artifact/delivery/output";

export interface WorkflowCommandDeps {
  /** The Session Companion's path; resolved from the launch environment by default. */
  resolveCompanion?: (cwd: string) => Promise<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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
  /** For `submit`: the declared type it handles, or null for the built-in type. */
  artifact?: string | null;
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
    ...(result.artifact === undefined ? [] : [`  artifact: ${result.artifact ?? "built-in"}`]),
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

/** Stages whose end the change's state and its publication record. */
const UNRECORDED_STAGES: ReadonlySet<string> = new Set(["submit", "publish"]);

/** The change's folder, or the companion-relative path it is expected at. */
async function changeFolder(
  companionPath: string,
  workflow: Workflow,
  change: string,
): Promise<{ dir: string } | { missing: string }> {
  if (workflow.submitArtifact === null) {
    const location = await locateChange(companionPath, change);
    return location && !location.archived
      ? { dir: location.dir }
      : { missing: `openspec/changes/${change}/` };
  }
  const type = submitArtifactType(workflow);
  const dir = sourceDir(companionPath, type, change);
  return (await pathIsDirectory(dir)) ? { dir } : { missing: `${type.source}/${change}/` };
}

/**
 * @command mate workflow done <stage> <change>
 * @description Records that a skill stage finished its steps for a change: sets
 * `stages.<stage>: done` in the change's `delivery.yaml` and changes nothing else in it. The
 * change is the folder of the artifact type submit handles.
 * @flags
 * - `--json` — emit `ok`, `stage`, `change` and `recorded`.
 * @remarks `submit` and `publish` record nothing: the change's `state` and its publication say
 * where it is. Exits 1 on an invalid declaration, an unknown or review stage, or a change whose
 * folder does not exist, naming the expected path.
 */
async function runDone(argv: string[], run: Run, deps: WorkflowCommandDeps): Promise<void> {
  const [id, change, ...extra] = positionalArgs(argv, BOOLEAN_FLAGS);
  if (!change || extra.length > 0 || !isChangeName(change)) {
    return fail(run, [
      { path: "", message: "workflow done requires a stage and one change name." },
    ]);
  }
  const resolved = await resolveWorkflow(run, deps);
  if (!resolved) return;
  const { companionPath, workflow } = resolved;
  const stage = skillStage(run, workflow, id);
  if (!stage) return;
  const recorded = !UNRECORDED_STAGES.has(stage.id);
  if (recorded) {
    const folder = await changeFolder(companionPath, workflow, change);
    if ("missing" in folder) {
      return fail(run, [
        { path: "", message: `${change} has no change folder at ${folder.missing}` },
      ]);
    }
    await recordStageDone(folder.dir, change, stage.id);
  }
  if (run.json) {
    run.emitOut(JSON.stringify({ ok: true, stage: stage.id, change, recorded }));
  } else {
    run.emitOut(
      recorded
        ? `${change}: ${stage.id} done`
        : `${change}: ${stage.id} records nothing; its state says where it is`,
    );
  }
}

/**
 * @command mate workflow <subcommand>
 * @description Dispatches to `steps` and `done`. Prints usage and sets a non-zero exit code for
 * an unrecognized subcommand.
 */
export async function runWorkflowCommand(
  subcommand: string | undefined,
  argv: string[],
  deps: WorkflowCommandDeps = {},
): Promise<void> {
  const run: Run = { ...commandOutput(deps), json: parseFlags(argv, BOOLEAN_FLAGS).json === true };
  switch (subcommand) {
    case "steps":
      await runSteps(argv, run, deps);
      return;
    case "done":
      await runDone(argv, run, deps);
      return;
    default:
      run.emitErr(`Unknown workflow command: ${subcommand ?? ""}`);
      run.emitErr(usage());
      process.exitCode = 1;
  }
}
