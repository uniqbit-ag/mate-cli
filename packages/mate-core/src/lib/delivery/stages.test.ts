import { describe, expect, test } from "bun:test";

import { parseWorkflow, type Workflow } from "../workflow/declaration";
import {
  canonicalSchema,
  DEFAULT_SCHEMA,
  DELIVERY_STAGE_SKILLS,
  deliveryPath,
  isMateSchema,
  SCHEMA_ARTIFACTS,
  SHIPPED_SCHEMAS,
} from "./stages";

const labels = (artifacts: readonly string[] | undefined): string[] =>
  deliveryPath(artifacts).stages.map((stage) => stage.label);

describe("deliveryPath", () => {
  test("the full schema yields one review stage per artifact in schema order", () => {
    expect(labels(SCHEMA_ARTIFACTS["mate-full"])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review proposal",
      "Review specs",
      "Review design",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Submit change",
      "Publish companion artifacts",
    ]);
  });

  test("the minimal schema yields only its own review stages around the shared stages", () => {
    expect(labels(SCHEMA_ARTIFACTS["mate-minimal"])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review specs",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Submit change",
      "Publish companion artifacts",
    ]);
  });

  test("each skill stage maps to its skill and every review stage maps to none", () => {
    const stages = deliveryPath(SCHEMA_ARTIFACTS["mate-full"]).stages;
    const skills = Object.fromEntries(stages.map((stage) => [stage.label, stage.skill]));
    expect(skills).toMatchObject({
      "Clarify intent": "mate-clarify-intent",
      "Explore change": "mate-explore-change",
      "Propose change": "mate-propose-change",
      "Apply change": "mate-apply-change",
      "Inspect outcome": "mate-show-me",
      "Refine code": "mate-simplify-code",
      "Submit change": "mate-submit-change",
      "Publish companion artifacts": "mate-publish-artifact",
    });
    for (const stage of stages.filter((entry) => entry.kind === "human")) {
      expect(stage.skill).toBeNull();
      expect(stage.artifact).toBeDefined();
    }
  });

  test("the stage label names the action and the skill is carried separately", () => {
    const submit = deliveryPath(SCHEMA_ARTIFACTS["mate-full"]).stages.find(
      (stage) => stage.id === "submit",
    );
    expect(submit).toMatchObject({ label: "Submit change", skill: "mate-submit-change" });
  });

  test("optional stages are independent peers and never required", () => {
    const stages = deliveryPath(SCHEMA_ARTIFACTS["mate-full"]).stages;
    const optional = stages.filter((stage) => stage.optional).map((stage) => stage.id);
    expect(optional).toEqual(["clarify-intent", "inspect-outcome", "refine-code"]);
    const required = stages.filter((stage) => !stage.optional).map((stage) => stage.id);
    expect(required).toContain("submit");
    expect(required).toContain("publish");
  });

  test("an unavailable schema yields no review stages and says so", () => {
    const path = deliveryPath(undefined);
    expect(path.reviewsKnown).toBe(false);
    expect(path.stages.some((stage) => stage.kind === "human")).toBe(false);
    expect(path.stages.map((stage) => stage.id)).toContain("apply");
  });

  test("a schema with other artifacts yields only those review stages", () => {
    expect(
      deliveryPath(["brief", "tasks"])
        .stages.filter((stage) => stage.kind === "human")
        .map((stage) => stage.label),
    ).toEqual(["Review brief", "Review tasks"]);
  });

  test("the skill list is the Mate stage skills", () => {
    expect(DELIVERY_STAGE_SKILLS).toEqual([
      "mate-clarify-intent",
      "mate-explore-change",
      "mate-propose-change",
      "mate-apply-change",
      "mate-show-me",
      "mate-simplify-code",
      "mate-submit-change",
      "mate-publish-artifact",
    ]);
  });
});

function declared(source: string): Workflow {
  const verdict = parseWorkflow(source);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

const TAIL = `
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

describe("deliveryPath of a declared workflow", () => {
  test("a custom stage sits where it is declared and removed stages are gone", () => {
    const workflow = declared(`version: 1
stages:
  - id: explore
    steps: [{ skill: mate-explore-change }]
  - id: propose
    steps: [{ skill: mate-propose-change }]
  - id: review
    review: [proposal, specs, tasks]
  - id: security-review
    label: Security review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }]
${TAIL}`);
    const stages = deliveryPath(SCHEMA_ARTIFACTS["mate-full"], workflow).stages;
    expect(stages.map((stage) => stage.id)).toEqual([
      "explore",
      "propose",
      "review-proposal",
      "review-specs",
      "review-tasks",
      "security-review",
      "apply",
      "submit",
      "publish",
    ]);
    expect(stages.find((stage) => stage.id === "security-review")).toMatchObject({
      label: "Security review",
      skill: "acme-security-review",
      steps: [{ skill: "acme-security-review" }],
      source: "declared",
    });
  });

  test("a listed review skips the artifacts the change's schema lacks", () => {
    const workflow = declared(`version: 1
stages:
  - id: propose
    steps: [{ skill: mate-propose-change }]
  - id: review
    review: [proposal, specs, tasks]
${TAIL}`);
    const reviews = (artifacts: readonly string[]): string[] =>
      deliveryPath(artifacts, workflow)
        .stages.filter((stage) => stage.kind === "human")
        .map((stage) => stage.id);
    expect(reviews(SCHEMA_ARTIFACTS["mate-minimal"])).toEqual(["review-specs", "review-tasks"]);
  });

  test("a declared type's reviews replace the schema's", () => {
    const workflow = declared(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    reviews: { brief: brief.md, plan: plan.md, risks: risks.md }
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: draft
    steps: [{ skill: acme-draft }]
  - id: plan-review
    review: [brief, plan]
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
    const path = deliveryPath(SCHEMA_ARTIFACTS["mate-full"], workflow);
    expect(path.stages.map((stage) => stage.id)).toEqual([
      "draft",
      "review-brief",
      "review-plan",
      "submit",
      "publish",
    ]);
    expect(path.stages[1]).toMatchObject({ group: "plan-review", artifact: "brief" });
    // Without a readable schema the type's reviews are still known.
    expect(deliveryPath(undefined, workflow).reviewsKnown).toBe(true);
  });
});

describe("schema names", () => {
  test("the legacy mate-v1 name yields the full Delivery Path", () => {
    expect(labels(SCHEMA_ARTIFACTS["mate-v1"])).toEqual(labels(SCHEMA_ARTIFACTS["mate-full"]));
  });

  test("mate-v1 is a Mate schema that maps to mate-full", () => {
    expect(isMateSchema("mate-v1")).toBe(true);
    expect(canonicalSchema("mate-v1")).toBe("mate-full");
    expect(canonicalSchema("mate-minimal")).toBe("mate-minimal");
  });

  test("an unknown name is no Mate schema and keeps its name", () => {
    expect(isMateSchema("acme-flow")).toBe(false);
    expect(canonicalSchema("acme-flow")).toBe("acme-flow");
  });

  test("the shipped list holds mate-full and mate-minimal, and mate-full is the default", () => {
    expect(SHIPPED_SCHEMAS).toEqual(["mate-full", "mate-minimal"]);
    expect(DEFAULT_SCHEMA).toBe("mate-full");
  });
});
