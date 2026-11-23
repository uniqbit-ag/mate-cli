import { describe, expect, it } from "bun:test";
import {
  defaultWorkflow,
  SCHEMA_ARTIFACTS,
  type StudioChange,
  type StudioCompanionPayload,
  type Milestone,
  type Workflow as DeliveryWorkflow,
  type WorkflowStage,
} from "@uniqbit/mate-core/studio";

import { positioned } from "../../../test/positioned";
import { changeStep } from "../overview/change-group";
import { workflowGraph } from "./graph";
import { buildPath, type WorkflowPath } from "./steps";

await import("../../../test/dom");
const { staticMarkup } = await import("../../../test/render");
const { Workflow } = await import("./workflow-view");

const MATE_SKILLS: Record<string, string> = {
  "clarify-intent": "mate-clarify-intent",
  explore: "mate-explore-change",
  propose: "mate-propose-change",
  apply: "mate-apply-change",
  submit: "mate-submit-change",
  publish: "mate-publish-artifact",
};

const MILESTONES: Record<string, Milestone> = {
  explore: "exists",
  propose: "planned",
  apply: "implemented",
  submit: "submitted",
  publish: "published",
};

/** A declared skill stage, started with its first step's skill. */
function skill(id: string, label: string, skills: string[], optional = false): WorkflowStage {
  const own = MATE_SKILLS[id];
  const milestone = MILESTONES[id];
  return {
    id,
    label,
    kind: "skill",
    optional,
    source: "declared",
    steps: skills.map((name) => (name === own ? { skill: name, own: true } : { skill: name })),
    entry: skills[0]!,
    ...(milestone ? { milestone } : {}),
  };
}

function review(id: string, label: string, artifacts: "schema" | string[]): WorkflowStage {
  return { id, label, kind: "review", optional: false, source: "declared", review: artifacts };
}

function declared(stages: WorkflowStage[], submitArtifact = "openspec"): DeliveryWorkflow {
  return {
    file: ".mate/config/workflow.yaml",
    stages,
    artifacts: [],
    submitArtifact,
    warnings: [],
  };
}

const SUBMIT = skill("submit", "Submit change", ["mate-submit-change"]);
const PUBLISH = skill("publish", "Publish companion artifacts", ["mate-publish-artifact"]);

/** explore, propose, a review of proposal, specs and tasks, security-review, apply, submit, publish. */
const WITH_SECURITY_REVIEW = declared([
  skill("explore", "Explore change", ["mate-explore-change"]),
  skill("propose", "Propose change", ["mate-propose-change"]),
  review("review", "Human review", ["proposal", "specs", "tasks"]),
  skill("security-review", "Security review", ["acme-security-review"]),
  skill("apply", "Apply change", ["mate-apply-change", "acme-verify"]),
  SUBMIT,
  PUBLISH,
]);

/** discover, draft, a review of the declared type's artifacts, build, submit, publish. */
const CUSTOM_ONLY: DeliveryWorkflow = {
  ...declared(
    [
      skill("discover", "Discover", ["acme-interview"]),
      skill("draft", "Draft", ["acme-draft-plan"]),
      review("plan-review", "Plan review", "schema"),
      skill("build", "Build", ["acme-tdd-build"]),
      SUBMIT,
      PUBLISH,
    ],
    "acme-notes",
  ),
  artifacts: [
    {
      name: "acme-notes",
      change: "notes/{name}/",
      published: ["notes/index.md"],
      reviews: [
        { id: "brief", file: "brief.md" },
        { id: "plan", file: "plan.md" },
      ],
      hooks: { apply: { run: "acme-notes merge {change}" } },
    },
  ],
};

const pathOf = (workflow: DeliveryWorkflow | null | undefined): WorkflowPath =>
  buildPath("mate-full", SCHEMA_ARTIFACTS["mate-full"], { workflow });

const stepOf = (path: WorkflowPath, id: string) => {
  const step = path.steps.find((entry) => entry.id === id);
  if (!step) throw new Error(`no stage ${id}`);
  return step;
};

const marked = (path: WorkflowPath): string[] =>
  path.steps.filter((step) => step.badges.includes("openspec")).map((step) => step.id);

describe("the default path", () => {
  it("is the same with and without the payload's default workflow", () => {
    expect(pathOf(defaultWorkflow())).toEqual(pathOf(undefined));
    expect(marked(pathOf(undefined))).toEqual(["explore", "propose", "apply", "submit"]);
  });
});

describe("a declared path", () => {
  const path = pathOf(WITH_SECURITY_REVIEW);
  const graph = workflowGraph(path);

  it("draws its stages in declared order, a custom stage between the review and apply", () => {
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "explore",
      "propose",
      "reviews",
      "security-review",
      "apply",
      "submit",
      "publish",
    ]);
    const reviews = graph.nodes.find((node) => node.id === "reviews");
    expect(reviews?.kind === "review-group" && reviews.steps.map((step) => step.id)).toEqual([
      "review-proposal",
      "review-specs",
      "review-tasks",
    ]);
  });

  it("has no bypass edge once every optional stage is removed", () => {
    expect(graph.edges.some((edge) => edge.kind === "bypass")).toBe(false);
    expect(path.steps.some((step) => step.optional)).toBe(false);
  });

  it("bands follow position", () => {
    expect(path.steps.map((step) => [step.id, step.phase])).toEqual([
      ["explore", "plan"],
      ["propose", "plan"],
      ["review-proposal", "review"],
      ["review-specs", "review"],
      ["review-tasks", "review"],
      ["security-review", "build"],
      ["apply", "build"],
      ["submit", "ship"],
      ["publish", "ship"],
    ]);
  });

  it("a custom stage is prompted with its own skill and names its steps", () => {
    const step = stepOf(path, "security-review");
    expect(step.copyPrompt).toBe("/acme-security-review for");
    expect(step.what).toBe("Runs acme-security-review.");
    expect(step.badges).toEqual(["skill"]);
  });

  it("a chain is prompted with its first step's skill", () => {
    const prepared = declared(
      WITH_SECURITY_REVIEW.stages.map((stage) =>
        stage.id === "apply"
          ? skill("apply", "Apply change", ["acme-prepare", "mate-apply-change"])
          : stage,
      ),
    );
    expect(stepOf(pathOf(prepared), "apply").copyPrompt).toBe("/acme-prepare for");
    expect(marked(pathOf(prepared))).toContain("apply");
  });

  it("a chain starting with the Mate stage skill is prompted with that skill", () => {
    const step = stepOf(path, "apply");
    expect(step.copyPrompt).toBe("/mate-apply-change for");
    expect(step.kind === "skill" && step.steps.map((entry) => entry.skill)).toEqual([
      "mate-apply-change",
      "acme-verify",
    ]);
    expect(step.sessionBreakBefore).toBe(true);
  });

  it("a stage that replaced its Mate skill loses the OpenSpec marker; the others keep theirs", () => {
    const replaced = declared(
      WITH_SECURITY_REVIEW.stages.map((stage) =>
        stage.id === "explore" ? skill("explore", "Explore change", ["acme-explore"]) : stage,
      ),
    );
    expect(marked(pathOf(replaced))).toEqual(["propose", "apply", "submit"]);
    expect(stepOf(pathOf(replaced), "explore").copyPrompt).toBe("/acme-explore for");
  });

  it("reports a declared skill the companion does not hold", () => {
    const reported = buildPath("mate-full", SCHEMA_ARTIFACTS["mate-full"], {
      workflow: WITH_SECURITY_REVIEW,
      skills: ["mate-apply-change"],
    });
    expect(stepOf(reported, "apply").missingSkill).toBe("acme-verify");
  });
});

describe("a path of custom stages only", () => {
  const path = pathOf(CUSTOM_ONLY);

  it("draws them in order with one group for its review stage", () => {
    const graph = workflowGraph(path);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "discover",
      "draft",
      "reviews-plan-review",
      "build",
      "submit",
      "publish",
    ]);
    // The declared type's reviews, not the schema's.
    const group = graph.nodes.find((node) => node.id === "reviews-plan-review");
    expect(group?.kind === "review-group" && group.steps.map((step) => step.label)).toEqual([
      "Review brief",
      "Review plan",
    ]);
    expect(graph.bands.map((band) => band.phase)).toEqual(["plan", "review", "build", "ship"]);
  });

  it("carries no OpenSpec marker, submit included", () => {
    expect(marked(path)).toEqual([]);
  });
});

describe("changes on a declared path", () => {
  const change = (
    name: string,
    done: number,
    extra: Partial<StudioChange> = {},
    workflow: DeliveryWorkflow = WITH_SECURITY_REVIEW,
  ): StudioChange =>
    positioned({ name, completedTasks: done, totalTasks: 4, artifacts: [], ...extra }, workflow);

  it("a change waits at a custom stage until it is recorded", () => {
    expect(changeStep(change("acme-login", 0), WITH_SECURITY_REVIEW)).toMatchObject({
      stage: "Human review",
      review: true,
      next: "Review the plan, then run Security review",
      prompt: "/acme-security-review acme-login",
    });
    expect(changeStep(change("acme-login", 1), WITH_SECURITY_REVIEW)).toMatchObject({
      stage: "Security review",
      stageId: "security-review",
      next: "Run Security review",
      prompt: "/acme-security-review acme-login",
    });
    expect(
      changeStep(
        change("acme-login", 1, { steps: { "security-review": ["acme-security-review"] } }),
        WITH_SECURITY_REVIEW,
      ),
    ).toMatchObject({ stage: "Apply change", prompt: "/mate-apply-change acme-login" });
  });

  it("a change at a custom stage once its tasks are done", () => {
    expect(changeStep(change("acme-login", 4), WITH_SECURITY_REVIEW)).toMatchObject({
      stage: "Security review",
      situation: "acme-security-review not recorded",
      prompt: "/acme-security-review acme-login",
    });
  });

  it("open tasks, as `mate workflow next` names them", () => {
    const fix = change("acme-fix", 2, {}, defaultWorkflow());
    expect(changeStep(fix)).toMatchObject({
      stage: "Apply change",
      situation: "2 tasks open",
      prompt: "/mate-apply-change acme-fix",
    });
  });

  it("a step after the Mate skill", () => {
    const chained = declared([
      skill("apply", "Apply change", ["mate-apply-change", "acme-verify"]),
      SUBMIT,
      PUBLISH,
    ]);
    expect(changeStep(change("acme-fix", 4, {}, chained), chained)).toMatchObject({
      stage: "Apply change",
      situation: "acme-verify not recorded",
      next: "Run acme-verify",
      prompt: "/acme-verify acme-fix",
    });
  });

  it("a plan that does not validate", () => {
    const invalid = change("acme-fix", 4, { valid: false }, defaultWorkflow());
    expect(changeStep(invalid)).toMatchObject({
      stage: "Propose change",
      situation: "the change does not validate",
      prompt: "/mate-propose-change acme-fix",
    });
  });

  it("the Workflow view counts it at that stage", () => {
    const html = staticMarkup(
      <Workflow
        payload={{ skills: [], topology: null, warnings: [], workflow: WITH_SECURITY_REVIEW }}
        changes={[change("acme-login", 1), change("acme-search", 0)]}
      />,
    );
    expect(html).toContain("1 change at Security review");
    expect(html).toContain("1 change waits for review");
    expect(html).toContain('data-map-stage="security-review"');
    expect(html).not.toContain('data-map-stage="clarify-intent"');
  });

  it("a dropped change is at no stage", () => {
    expect(changeStep(change("acme-old", 2, { dropped: true }))).toMatchObject({
      stage: "Dropped",
      stageId: null,
    });
  });
});

describe("an invalid declaration", () => {
  const payload: Pick<StudioCompanionPayload, "skills" | "topology" | "warnings" | "workflow"> = {
    skills: [],
    topology: null,
    workflow: null,
    warnings: [
      ".mate/config/workflow.yaml is invalid, so the built-in Delivery Path is shown and no stage runs: publishing: unknown key `publishing`",
    ],
  };

  it("draws the default path without step lists", () => {
    const path = pathOf(null);
    expect(path.stepsKnown).toBe(false);
    expect(path.steps.map((step) => step.id)).toEqual(
      pathOf(undefined).steps.map((step) => step.id),
    );
  });

  it("shows a warning naming the file and its problems above the graph", () => {
    const html = staticMarkup(<Workflow payload={payload} />);
    expect(html).toContain(".mate/config/workflow.yaml is invalid");
    expect(html).toContain("unknown key `publishing`");
    expect(html.indexOf("workflow.yaml is invalid")).toBeLessThan(html.indexOf("workflow-view"));
    expect(html).toContain('data-map-stage="clarify-intent"');
  });
});
