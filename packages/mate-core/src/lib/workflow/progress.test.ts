import { describe, expect, test } from "bun:test";

import { defaultWorkflow, parseWorkflow, type Workflow } from "./declaration";
import { changeStage, type ChangeFacts, type PlanFacts } from "./progress";

function declared(source: string): Workflow {
  const verdict = parseWorkflow(source);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

const TAIL = `  - id: submit
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

const WITH_SECURITY_REVIEW = declared(`version: 1
stages:
  - id: explore
    steps: [{ skill: mate-explore-change }]
  - id: propose
    steps: [{ skill: mate-propose-change }]
  - id: review
    review: schema
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }]
${TAIL}`);

const NOTES = declared(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    reviews: { brief: brief.md }
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: draft
    steps: [{ skill: acme-draft }]
  - id: plan-review
    review: schema
  - id: build
    steps: [{ skill: acme-build }]
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);

const plan = (completedTasks: number, totalTasks: number, valid = true): PlanFacts => ({
  valid,
  totalTasks,
  completedTasks,
});

const at = (workflow: Workflow, facts: Partial<ChangeFacts>): string | null =>
  changeStage(workflow, { recorded: [], ...facts })?.id ?? null;

describe("changeStage on the default path", () => {
  const workflow = defaultWorkflow();

  test.each([
    ["an invalid plan", plan(0, 4, false), "propose"],
    ["no tasks yet", plan(0, 0), "propose"],
    ["a plan ready for review", plan(0, 4), "review"],
    ["a started build", plan(1, 4), "apply"],
    ["every task done", plan(4, 4), "submit"],
  ])("%s is inferred as before", (_, facts, stage) => {
    expect(at(workflow, { plan: facts })).toBe(stage);
  });

  test("a recorded stage counts without inference", () => {
    expect(at(workflow, { plan: plan(1, 4), recorded: ["apply"] })).toBe("submit");
  });

  test("a submitted change is at publish, blocked or not", () => {
    expect(at(workflow, { plan: plan(4, 4), state: "submitted" })).toBe("publish");
    expect(at(workflow, { plan: plan(4, 4), state: "submitted", blocked: true })).toBe("publish");
  });

  test("a dropped change is at no stage", () => {
    expect(at(workflow, { plan: plan(4, 4), state: "dropped" })).toBeNull();
  });
});

describe("changeStage on a declared path", () => {
  test("a change waits at a custom stage until it is recorded", () => {
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(0, 4) })).toBe("review");
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(1, 4) })).toBe("security-review");
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(4, 4) })).toBe("security-review");
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(1, 4), recorded: ["security-review"] })).toBe(
      "apply",
    );
  });

  test("nothing is inferred for a declared type's change", () => {
    expect(at(NOTES, { plan: plan(4, 4) })).toBe("draft");
    expect(at(NOTES, { recorded: ["draft"] })).toBe("plan-review");
    // Its review counts as done once a later stage is recorded.
    expect(at(NOTES, { recorded: ["draft", "build"] })).toBe("submit");
    expect(at(NOTES, { recorded: ["draft", "build"], state: "submitted" })).toBe("publish");
  });
});
