import type { RunOpenSpec } from "../../openspec-cli";
import {
  loadWorkflow,
  submitType,
  WORKFLOW_FILE,
  type Workflow,
  type WorkflowProblem,
} from "../../workflow/declaration";
import type { ArtifactType } from "./artifact-type";
import { declaredArtifactType } from "./declared-type";
import { openspecArtifactType } from "./openspec-type";

/**
 * The artifact types Mate knows. The only module besides each type's own that names a type;
 * submit, publication, discovery and sync receive a type or ask here.
 */

/**
 * Every artifact type, the default first: OpenSpec, the only built-in one, then those
 * `workflow` declares.
 */
export function artifactTypes(runner?: RunOpenSpec, workflow?: Workflow): ArtifactType[] {
  return [
    openspecArtifactType(runner),
    ...(workflow?.artifacts ?? []).map((type) => declaredArtifactType(type)),
  ];
}

/** The type submit and publication use unless a caller passes one. */
export function defaultArtifactType(runner?: RunOpenSpec): ArtifactType {
  return artifactTypes(runner)[0]!;
}

/** The type `workflow`'s submit handles: the declared one it names, else the built-in type. */
export function submitArtifactType(workflow: Workflow, runner?: RunOpenSpec): ArtifactType {
  const declared = submitType(workflow);
  return declared ? declaredArtifactType(declared) : defaultArtifactType(runner);
}

/** An invalid declaration as one message naming the file and each problem's key path. */
export function describeWorkflowProblems(problems: readonly WorkflowProblem[]): string {
  const lines = problems.map(
    (problem) => `  ${problem.path ? `${problem.path}: ` : ""}${problem.message}`,
  );
  return `${WORKFLOW_FILE} is invalid; fix it, then run this again.\n${lines.join("\n")}`;
}

/**
 * The declared type the companion's submit handles, from its workflow declaration; undefined
 * for the built-in type. Throws on an invalid declaration, naming each problem: a guess would
 * submit or publish the wrong files.
 */
export async function declaredSubmitType(companionPath: string): Promise<ArtifactType | undefined> {
  const verdict = await loadWorkflow(companionPath);
  if (!verdict.ok) throw new Error(describeWorkflowProblems(verdict.problems));
  const declared = submitType(verdict.workflow);
  return declared ? declaredArtifactType(declared) : undefined;
}
