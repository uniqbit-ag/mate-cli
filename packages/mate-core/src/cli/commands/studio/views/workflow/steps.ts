import { CHANGE_PLACEHOLDER } from "../../selection";

export type WorkflowStepKind = "skill" | "review" | "completion" | "optional";
export type WorkflowStepBadge = "optional" | "skill" | "openspec" | "human-in-loop";
export type WorkflowProfile = "mate-v1" | "mate-minimal";

export interface WorkflowAlternative {
  name: string;
  description: string;
  prompt: string;
  copyPrompt: string;
}

export interface WorkflowStep {
  kind: WorkflowStepKind;
  id: string;
  /** The action the stage performs. */
  what: string;
  /** The reason the stage is in the sequence at this position. */
  why: string;
  title: string;
  badges: WorkflowStepBadge[];
  sessionBreakBefore?: boolean;
  prompt: string;
  copyPrompt: string;
  alternatives?: WorkflowAlternative[];
}

export interface WorkflowBranch {
  profile: WorkflowProfile;
  label: string;
  description: string;
  steps: WorkflowStep[];
}

export interface WorkflowPlan {
  start: WorkflowStep;
  branches: WorkflowBranch[];
  shared: WorkflowStep[];
  finish: WorkflowStep;
}

const PRE_EXPLORE_SKILLS = ["mate-interview-me", "mate-grill-me"] as const;

function stepPrompt(
  step: Omit<WorkflowStep, "prompt" | "copyPrompt">,
  profile?: WorkflowProfile,
  includeChange = true,
): string {
  const changeNote = includeChange ? ` for ${CHANGE_PLACEHOLDER}` : " for";
  const schemaNote = profile ? ` (use schema: ${profile})` : "";

  switch (step.id) {
    case "pre-explore":
      return `/mate-interview-me or /mate-grill-me${changeNote}`;
    case "explore":
      return `/openspec-explore${schemaNote}${changeNote}`;
    case "proposal":
    case "propose":
      return `/openspec-propose${schemaNote}${changeNote}`;
    case "specs":
      return `Review specs/${schemaNote}${changeNote}`;
    case "design":
      return `Review design.md${schemaNote}${changeNote}`;
    case "tasks":
      return `Review tasks.md${schemaNote}${changeNote}`;
    case "apply":
      return `/openspec-apply-change${schemaNote}${changeNote}`;
    case "simplify":
      return `/mate-simplify-code${changeNote}`;
    case "finish":
      return `/mate-artifact-finish${changeNote}`;
    default:
      return `Use ${step.title}${schemaNote}${changeNote}`;
  }
}

function skillStep(
  id: string,
  title: string,
  what: string,
  why: string,
  profile?: WorkflowProfile,
): WorkflowStep {
  const step = {
    kind: "skill" as const,
    id,
    title,
    what,
    why,
    badges: ["skill", "openspec"] as WorkflowStepBadge[],
  };
  return {
    ...step,
    prompt: stepPrompt(step, profile),
    copyPrompt: stepPrompt(step, profile, false),
  };
}

function reviewStep(
  id: string,
  title: string,
  what: string,
  why: string,
  profile?: WorkflowProfile,
): WorkflowStep {
  const step = {
    kind: "review" as const,
    id,
    title,
    what,
    why,
    badges: ["human-in-loop", "openspec"] as WorkflowStepBadge[],
  };
  return {
    ...step,
    prompt: stepPrompt(step, profile),
    copyPrompt: stepPrompt(step, profile, false),
  };
}

function optionalStep(
  id: "pre-explore" | "simplify",
  title: string,
  what: string,
  why: string,
  alternatives: WorkflowAlternative[] = [],
): WorkflowStep {
  const step = {
    kind: "optional" as const,
    id,
    title,
    what,
    why,
    badges: ["optional", "skill"] as WorkflowStepBadge[],
  };
  return {
    ...step,
    prompt: stepPrompt(step),
    copyPrompt: stepPrompt(step, undefined, false),
    ...(id === "pre-explore" || alternatives.length > 0 ? { alternatives } : {}),
  };
}

function withSessionBreak(step: WorkflowStep): WorkflowStep {
  return { ...step, sessionBreakBefore: true };
}

export function workflowPlan(
  availableSkills: readonly string[] = [...PRE_EXPLORE_SKILLS],
): WorkflowPlan {
  const start = optionalStep(
    "pre-explore",
    "pre-explore",
    "Clarifies intent with confidence and explicit confirmation, or stress-tests the full design frontier before the schema path turns it into artifacts.",
    "One conversational choice settles uncertainty early without invoking documentation or implementation work.",
    PRE_EXPLORE_SKILLS.filter((name) => availableSkills.includes(name)).map((name) => ({
      name,
      description:
        name === "mate-interview-me"
          ? "Difference: guided, one-question-at-a-time clarification. Best when: the request is ambiguous and intent, constraints, or scope still need confirmation."
          : "Difference: adversarial, round-based review of the full design-tree frontier. Best when: the direction is mostly known but hidden assumptions, risks, and downstream impacts need surfacing.",
      prompt: `/${name} for ${CHANGE_PLACEHOLDER}`,
      copyPrompt: `/${name} for`,
    })),
  );

  const branches: WorkflowBranch[] = [
    {
      profile: "mate-v1",
      label: "mate-v1",
      description: "Full planning path for changes that need exploration and technical design.",
      steps: [
        skillStep(
          "explore",
          "explore",
          "Resolves repository evidence, unknowns, options, and direction.",
          "It separates uncertainty from the proposal's committed motivation and scope.",
          "mate-v1",
        ),
        skillStep(
          "proposal",
          "proposal",
          "Commits why the change is needed and what is in scope.",
          "A written scope gives specs, design, and tasks one decision to build from.",
          "mate-v1",
        ),
        reviewStep(
          "specs",
          "specs",
          "Defines the observable behavior the system must provide.",
          "The delta is the contract that will later be merged into the canonical spec.",
          "mate-v1",
        ),
        reviewStep(
          "design",
          "design",
          "Records the technical decisions for implementing the change.",
          "Separating how from what exposes risks before implementation starts.",
          "mate-v1",
        ),
        reviewStep(
          "tasks",
          "tasks",
          "Orders the implementation and verification work.",
          "Small, ordered tasks turn the agreed artifacts into a trackable build path.",
          "mate-v1",
        ),
        withSessionBreak(
          skillStep(
            "apply",
            "apply",
            "Implements the change by working through the generated tasks.",
            "Applying only approved tasks keeps code changes inside the agreed scope.",
            "mate-v1",
          ),
        ),
      ],
    },
    {
      profile: "mate-minimal",
      label: "mate-minimal",
      description:
        "Short path that creates only specs and tasks for one-Area, low-risk changes; switch to mate-v1 when uncertain.",
      steps: [
        skillStep(
          "propose",
          "propose",
          "Creates the concise, parser-compatible behavior change.",
          "OpenSpec generates the minimal specs and tasks artifacts from the agreed direction.",
          "mate-minimal",
        ),
        reviewStep(
          "specs",
          "specs",
          "Defines the behavior change as a concise, parser-compatible user story.",
          "Reviewing the generated delta confirms the small change before tasks are applied.",
          "mate-minimal",
        ),
        reviewStep(
          "tasks",
          "tasks",
          "Orders the implementation and verification work.",
          "The checklist keeps a deliberately small change concrete and reviewable.",
          "mate-minimal",
        ),
        withSessionBreak(
          skillStep(
            "apply",
            "apply",
            "Implements the change by working through the generated tasks.",
            "Applying only the short approved checklist keeps the low-risk boundary intact.",
            "mate-minimal",
          ),
        ),
      ],
    },
  ];

  const simplify = withSessionBreak(
    optionalStep(
      "simplify",
      "mate simplify code",
      "Looks for smaller, clearer code once the tests pass, preserving behavior and rerunning the relevant tests.",
      "Cleanup lands before the specs are archived, so shipped code and recorded specs stay aligned.",
    ),
  );
  const finishStep = {
    kind: "completion" as const,
    id: "finish",
    title: "mate artifact finish",
    what: "Archives the change and applies its delta specs to the canonical specs.",
    why: "It is the only sanctioned completion; a hand-committed finish leaves the canonical specs stale.",
    badges: ["skill"] as WorkflowStepBadge[],
  };

  return {
    start,
    branches,
    shared: [simplify],
    finish: {
      ...finishStep,
      prompt: stepPrompt(finishStep),
      copyPrompt: stepPrompt(finishStep, undefined, false),
    },
  };
}

export function workflowSteps(profile: WorkflowProfile = "mate-v1"): WorkflowStep[] {
  const plan = workflowPlan();
  const branch = plan.branches.find((entry) => entry.profile === profile);
  if (!branch) return [plan.start, ...plan.shared, plan.finish];
  return [plan.start, ...branch.steps, ...plan.shared, plan.finish];
}
