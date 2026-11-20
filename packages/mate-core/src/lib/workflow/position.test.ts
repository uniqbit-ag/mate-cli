import { describe, expect, test } from "bun:test";

import {
  defaultWorkflow,
  parseWorkflow,
  type Workflow,
  type WorkflowSkillStage,
} from "./declaration";
import { handoffLines, renderHandoff, type Handoff } from "./handoff";
import {
  pathPosition,
  stagesBeforeWork,
  stepStage,
  type PathPlan,
  type PathPosition,
  type PathProgress,
  type PathSubject,
} from "./position";

function declared(source: string): Workflow {
  const verdict = parseWorkflow(source);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

const TAIL = `  - id: submit
    artifact: openspec
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

const CHAINED = declared(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
${TAIL}`);

const DECLARED = declared(`version: 1
stages:
  - id: propose
    steps: [{ skill: mate-propose-change }]
  - id: review
    review: [specs]
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: demo
    optional: true
    steps: [{ skill: acme-demo }]
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

const plan = (completedTasks: number, totalTasks: number, valid = true): PathPlan => ({
  valid,
  totalTasks,
  completedTasks,
});

const at = (workflow: Workflow, facts: Partial<PathProgress>): string | null =>
  pathPosition(workflow, { steps: {}, ...facts }).stage?.id ?? null;

const openOf = (workflow: Workflow, facts: PathProgress): string[] =>
  pathPosition(workflow, facts).openSteps.apply ?? [];

const countedOf = (workflow: Workflow, facts: PathProgress): Record<string, string[]> =>
  pathPosition(workflow, facts).counted;

const unfinishedOf = (workflow: Workflow, facts: PathProgress): Record<string, string> =>
  Object.fromEntries(
    pathPosition(workflow, facts).unfinished.map(({ stage, open }) => [stage.id, open]),
  );

const stageOf = (workflow: Workflow, id: string): WorkflowSkillStage =>
  workflow.stages.find((stage) => stage.id === id) as WorkflowSkillStage;

const V1 = ["proposal.md", "specs/", "design.md", "tasks.md"];
const MINIMAL = ["specs/", "tasks.md"];

interface Given {
  tasks?: [done: number, total: number];
  steps?: Record<string, string[]>;
  state?: "submitted" | "dropped";
  files?: string[];
  unmerged?: string[];
}

/** A change as the change adapter reads it. */
function change(
  workflow: Workflow,
  name: string,
  given: Given = {},
): { progress: PathProgress; subject: PathSubject } {
  const [done, total] = given.tasks ?? [0, 0];
  const folder =
    workflow.submitArtifact === "openspec" ? `openspec/changes/${name}` : `notes/${name}`;
  return {
    progress: {
      steps: given.steps ?? {},
      ...(given.state ? { state: given.state } : {}),
      ...(workflow.submitArtifact === "openspec" ? { plan: plan(done, total) } : {}),
    },
    subject: {
      name,
      artifacts: (given.files ?? MINIMAL).map((file) => ({
        id: file.replace(/(\.md|\/)$/, ""),
        path: `${folder}/${file}`,
      })),
      unmerged: given.unmerged ?? [],
    },
  };
}

const render = (handoff: Handoff): string => renderHandoff(handoff, "claude");

/** The hand-off after the first step of stage `finished` was reported. */
const data = (workflow: Workflow, finished: string, name: string, given?: Given): Handoff => {
  const { progress, subject } = change(workflow, name, given);
  return pathPosition(workflow, progress, subject, stageOf(workflow, finished).entry).handoff;
};

const handoff = (workflow: Workflow, finished: string, name: string, given?: Given): string =>
  render(data(workflow, finished, name, given));

/** The hand-off after step `after` was reported for work that does not exist yet. */
const before = (workflow: Workflow, after: string, name?: string): Handoff =>
  pathPosition(workflow, null, name ? { name } : {}, after).handoff;

/** Where change `name` stands. */
const standing = (workflow: Workflow, name: string, given: Given): PathPosition => {
  const { progress, subject } = change(workflow, name, given);
  return pathPosition(workflow, progress, subject);
};

describe("the stage on the default path", () => {
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

  test("a recorded step does not override the plan", () => {
    const steps = { apply: ["mate-apply-change"] };
    expect(at(workflow, { plan: plan(1, 4), steps })).toBe("apply");
    expect(at(workflow, { plan: plan(4, 4), steps })).toBe("submit");
  });

  test("a Mate stage skill the plan covers needs no record", () => {
    expect(at(workflow, { plan: plan(4, 4) })).toBe("submit");
  });

  test("a submitted change is at publish", () => {
    expect(at(workflow, { plan: plan(4, 4), state: "submitted" })).toBe("publish");
  });

  test("a dropped change is at no stage", () => {
    expect(at(workflow, { plan: plan(4, 4), state: "dropped" })).toBeNull();
  });
});

describe("the stage on a declared path", () => {
  test("a change waits at a custom stage until it is recorded", () => {
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(0, 4) })).toBe("review");
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(1, 4) })).toBe("security-review");
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(4, 4) })).toBe("security-review");
    const steps = { "security-review": ["acme-security-review"] };
    expect(at(WITH_SECURITY_REVIEW, { plan: plan(1, 4), steps })).toBe("apply");
  });

  test("a chained built-in stage waits for its own steps and for its tasks", () => {
    expect(at(CHAINED, { plan: plan(4, 4) })).toBe("apply");
    expect(at(CHAINED, { plan: plan(4, 4), steps: { apply: ["mate-apply-change"] } })).toBe(
      "apply",
    );
    // The plan covers the Mate stage skill, so its missing report blocks nothing.
    expect(at(CHAINED, { plan: plan(4, 4), steps: { apply: ["acme-verify"] } })).toBe("submit");
    const both = { apply: ["mate-apply-change", "acme-verify"] };
    expect(at(CHAINED, { plan: plan(4, 4), steps: both })).toBe("submit");
    // Tasks added after the steps were recorded reopen the stage; no step is recorded again.
    expect(at(CHAINED, { plan: plan(4, 5), steps: both })).toBe("apply");
  });

  test("openSteps leaves out the Mate stage skill only while the plan covers it", () => {
    const facts = (done: number, steps: string[] = []): PathProgress => ({
      steps: { apply: steps },
      plan: plan(done, 4),
    });

    expect(openOf(CHAINED, facts(4))).toEqual(["acme-verify"]);
    expect(openOf(CHAINED, facts(3))).toEqual(["mate-apply-change", "acme-verify"]);
    expect(openOf(CHAINED, facts(3, ["mate-apply-change"]))).toEqual(["acme-verify"]);
  });

  test("a step added to the declaration reopens its stage and a removed one is ignored", () => {
    const steps = { apply: ["mate-apply-change"] };
    expect(at(CHAINED, { plan: plan(4, 5), steps: {} })).toBe("apply");
    expect(openOf(CHAINED, { steps, plan: plan(4, 5) })).toEqual(["acme-verify"]);
    const extra = { apply: ["mate-apply-change", "acme-verify"] };
    expect(at(defaultWorkflow(), { plan: plan(4, 4), steps: extra })).toBe("submit");
  });

  test("a required built-in stage the plan says nothing about needs its record", () => {
    const workflow = declared(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }]
  - id: inspect-outcome
    steps: [{ skill: mate-show-me }]
${TAIL}`);

    expect(at(workflow, { plan: plan(4, 4) })).toBe("inspect-outcome");
    const steps = { "inspect-outcome": ["mate-show-me"] };
    expect(at(workflow, { plan: plan(4, 4), steps })).toBe("submit");
  });

  test("a required inspect-outcome counts only once the change is submitted", () => {
    const workflow = declared(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }]
  - id: inspect-outcome
    steps: [{ skill: mate-show-me }]
${TAIL}`);
    const facts = { steps: { apply: ["mate-apply-change"] }, plan: plan(4, 4) };

    expect(countedOf(workflow, facts)).toEqual({});
    expect(countedOf(workflow, { ...facts, state: "submitted" })).toEqual({
      "inspect-outcome": ["mate-show-me"],
    });
  });

  test("unfinished names each required stage before submit that is not done", () => {
    const facts = { steps: {}, plan: plan(4, 4) };

    expect(unfinishedOf(CHAINED, facts)).toEqual({ apply: "acme-verify not recorded" });
    expect(unfinishedOf(defaultWorkflow(), facts)).toEqual({});
    expect(unfinishedOf(defaultWorkflow(), { steps: {}, plan: plan(0, 0) })).toEqual({
      propose: "no tasks",
      apply: "no tasks",
    });
  });

  test("nothing is inferred for a declared type's change", () => {
    expect(at(NOTES, { plan: plan(4, 4) })).toBe("draft");
    expect(at(NOTES, { steps: { draft: ["acme-draft"] } })).toBe("plan-review");
    // Its review counts as done once a later stage has a recorded step.
    const steps = { draft: ["acme-draft"], build: ["acme-build"] };
    expect(at(NOTES, { steps })).toBe("submit");
    expect(at(NOTES, { steps, state: "submitted" })).toBe("publish");
  });
});

describe("countedSteps", () => {
  const LINTED = declared(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-lint }, { skill: acme-verify }]
${TAIL}`);

  test("a custom stage before apply counts once apply is recorded", () => {
    const facts = { steps: { apply: ["mate-apply-change"] }, plan: plan(4, 4) };

    expect(countedOf(WITH_SECURITY_REVIEW, facts)).toEqual({
      "security-review": ["acme-security-review"],
    });
    expect(at(WITH_SECURITY_REVIEW, facts)).toBe("submit");
  });

  test("a middle step of a chain counts once a later step is recorded", () => {
    const facts = { steps: { apply: ["mate-apply-change", "acme-verify"] }, plan: plan(4, 4) };

    expect(countedOf(LINTED, facts)).toEqual({ apply: ["acme-lint"] });
    expect(openOf(LINTED, facts)).toEqual([]);
    expect(at(LINTED, facts)).toBe("submit");
  });

  test("a step with no later record stays open", () => {
    const facts = { steps: { apply: ["mate-apply-change"] }, plan: plan(4, 4) };

    expect(countedOf(LINTED, facts)).toEqual({});
    expect(openOf(LINTED, facts)).toEqual(["acme-lint", "acme-verify"]);
    // A step covered by the plan is no later record.
    expect(countedOf(WITH_SECURITY_REVIEW, { steps: {}, plan: plan(4, 4) })).toEqual({});
  });

  test("submitting counts every unreported step before mate-submit-change", () => {
    expect(countedOf(LINTED, { steps: {}, plan: plan(4, 4), state: "submitted" })).toEqual({
      apply: ["acme-lint", "acme-verify"],
    });
  });

  test("a declared type's change counts its own steps", () => {
    expect(countedOf(NOTES, { steps: { build: ["acme-build"] } })).toEqual({
      draft: ["acme-draft"],
    });
  });
});

describe("the hand-off on the default path", () => {
  const workflow = defaultWorkflow();

  test("propose hands off to the reviews of a mate-minimal change, then apply", () => {
    expect(handoff(workflow, "propose", "acme-queue", { tasks: [0, 3] })).toBe(
      [
        "## Next steps",
        "1. Review specs: openspec/changes/acme-queue/specs/",
        "2. Review tasks: openspec/changes/acme-queue/tasks.md",
        "3. After your review: /mate-apply-change acme-queue",
      ].join("\n"),
    );
  });

  test("a mate-v1 change lists its four artifacts in review order", () => {
    const text = handoff(workflow, "propose", "acme-queue", { tasks: [0, 3], files: V1 });

    expect(text.split("\n").slice(1, 5)).toEqual([
      "1. Review proposal: openspec/changes/acme-queue/proposal.md",
      "2. Review specs: openspec/changes/acme-queue/specs/",
      "3. Review design: openspec/changes/acme-queue/design.md",
      "4. Review tasks: openspec/changes/acme-queue/tasks.md",
    ]);
  });

  test("propose without tasks stays at propose and says what is open", () => {
    expect(handoff(workflow, "propose", "acme-queue")).toBe(
      "## Next steps\n1. /mate-propose-change acme-queue (no tasks)",
    );
  });

  test("apply with open tasks stays at apply", () => {
    expect(handoff(workflow, "apply", "acme-queue", { tasks: [2, 4] })).toBe(
      "## Next steps\n1. /mate-apply-change acme-queue (2 tasks open)",
    );
  });

  test("apply hands off to submit, with the optional stages in one line above", () => {
    expect(handoff(workflow, "apply", "acme-queue", { tasks: [4, 4] })).toBe(
      [
        "Optional, any order: /mate-show-me acme-queue, /mate-simplify-code acme-queue.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-queue",
      ].join("\n"),
    );
  });

  test("the optional stages on the way are always offered", () => {
    const text = handoff(workflow, "apply", "acme-queue", { tasks: [4, 4] });

    expect(text.split("\n")[0]).toBe(
      "Optional, any order: /mate-show-me acme-queue, /mate-simplify-code acme-queue.",
    );
  });

  test("an optional stage hands off from the change's position", () => {
    expect(handoff(workflow, "inspect-outcome", "acme-queue", { tasks: [4, 4] })).toBe(
      "Optional: /mate-simplify-code acme-queue.\n\n## Next steps\n1. /mate-submit-change acme-queue",
    );
    expect(handoff(workflow, "inspect-outcome", "acme-queue", { tasks: [1, 4] })).toBe(
      "## Next steps\n1. /mate-apply-change acme-queue",
    );
  });

  test("submit hands off to the merges, then publication", () => {
    const given: Given = { tasks: [4, 4], state: "submitted", unmerged: ["workset/acme-queue"] };

    expect(handoff(workflow, "submit", "acme-queue", given)).toBe(
      "## Next steps\n1. Merge workset/acme-queue\n2. /mate-publish-artifact",
    );
    expect(handoff(workflow, "submit", "acme-queue", { ...given, unmerged: [] })).toBe(
      "## Next steps\n1. /mate-publish-artifact",
    );
  });

  test("a submit that did not land stays at submit", () => {
    expect(handoff(workflow, "submit", "acme-queue", { tasks: [4, 4] })).toBe(
      "## Next steps\n1. /mate-submit-change acme-queue (not submitted)",
    );
  });

  test("nothing follows publish or a dropped change", () => {
    expect(handoff(workflow, "publish", "acme-queue", { state: "submitted" })).toBe("");
    expect(handoff(workflow, "apply", "acme-queue", { state: "dropped" })).toBe("");
  });

  test("without progress, a stage hands off to the next in order, unnamed", () => {
    expect(render(before(workflow, "mate-explore-change"))).toBe(
      "## Next steps\n1. /mate-propose-change",
    );
    expect(render(before(workflow, "mate-clarify-intent"))).toBe(
      "## Next steps\n1. /mate-explore-change",
    );
    expect(render(before(workflow, "mate-publish-artifact"))).toBe("");
  });

  test("without progress, the hand-off names the work when it has a name", () => {
    expect(render(before(workflow, "mate-explore-change", "acme-queue"))).toBe(
      "## Next steps\n1. /mate-propose-change acme-queue",
    );
  });

  test("without progress or a step, the first required stage follows", () => {
    expect(pathPosition(workflow, null).stage?.id).toBe("explore");
    expect(render(pathPosition(workflow, null).handoff)).toBe(
      "Optional: /mate-clarify-intent.\n\n## Next steps\n1. /mate-explore-change",
    );
  });

  test("a step whose stage records nothing hands off to the named step", () => {
    expect(render(before(DECLARED, "mate-apply-change", "acme-queue"))).toBe(
      "## Next steps\n1. /acme-verify acme-queue",
    );
    expect(render(before(DECLARED, "mate-apply-change"))).toBe("## Next steps\n1. /acme-verify");
  });
});

describe("the hand-off on a declared path", () => {
  test("a review stage lists the artifacts it names, then the custom stage after it", () => {
    expect(handoff(DECLARED, "propose", "acme-login", { tasks: [0, 3] })).toBe(
      [
        "## Next steps",
        "1. Review specs: openspec/changes/acme-login/specs/",
        "2. After your review: /acme-security-review acme-login",
      ].join("\n"),
    );
  });

  test("an open earlier stage comes first", () => {
    expect(handoff(DECLARED, "apply", "acme-login", { tasks: [4, 4] })).toBe(
      "## Next steps\n1. /acme-security-review acme-login",
    );
  });

  test("a custom step the session did not report is counted, named above the section", () => {
    const steps = { apply: ["mate-apply-change", "acme-verify"] };

    expect(handoff(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps })).toBe(
      [
        "Counted, not reported: /acme-security-review acme-login. Not an action below; run it if it did not run.",
        "Optional: /acme-demo acme-login.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-login",
      ].join("\n"),
    );
    // Once submitted, the submit warning names it instead.
    expect(
      handoff(DECLARED, "submit", "acme-login", { tasks: [4, 4], steps, state: "submitted" }),
    ).toBe("## Next steps\n1. /mate-publish-artifact");
  });

  test("a stage with several steps hands off to its next step, then past the optional stage", () => {
    const steps = { "security-review": ["acme-security-review"], apply: ["mate-apply-change"] };

    expect(handoff(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps })).toBe(
      "## Next steps\n1. /acme-verify acme-login",
    );
    // Open tasks send the change back to the stage's Mate skill, not on to the next step.
    expect(handoff(DECLARED, "apply", "acme-login", { tasks: [3, 4], steps })).toBe(
      "## Next steps\n1. /mate-apply-change acme-login (1 task open)",
    );
    expect(
      handoff(DECLARED, "apply", "acme-login", {
        tasks: [4, 4],
        steps: { ...steps, apply: ["mate-apply-change", "acme-verify"] },
      }),
    ).toBe("Optional: /acme-demo acme-login.\n\n## Next steps\n1. /mate-submit-change acme-login");
  });

  test("a Mate stage skill that did not report itself hands off to the next step", () => {
    const steps = { "security-review": ["acme-security-review"] };

    expect(handoff(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps })).toBe(
      "## Next steps\n1. /acme-verify acme-login",
    );
  });

  test("a step skipped before the reported one is counted, not listed as an action", () => {
    const workflow = declared(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-lint }, { skill: acme-verify }]
${TAIL}`);
    const given: Given = { tasks: [4, 4], steps: { apply: ["mate-apply-change", "acme-verify"] } };

    expect(handoff(workflow, "apply", "acme-fix", given)).toBe(
      [
        "Counted, not reported: /acme-lint acme-fix. Not an action below; run it if it did not run.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-fix",
      ].join("\n"),
    );
    // Without a later record the next step in order is the action.
    const first: Given = { tasks: [4, 4], steps: { apply: ["mate-apply-change"] } };
    expect(handoff(workflow, "apply", "acme-fix", first)).toBe(
      "## Next steps\n1. /acme-lint acme-fix",
    );
  });

  test("several counted steps share one line", () => {
    const workflow = declared(`version: 1
stages:
  - id: apply
    steps:
      - { skill: mate-apply-change }
      - { skill: acme-lint }
      - { skill: acme-audit }
      - { skill: acme-verify }
${TAIL}`);
    const given: Given = { tasks: [4, 4], steps: { apply: ["mate-apply-change", "acme-verify"] } };

    expect(handoff(workflow, "apply", "acme-fix", given)).toBe(
      [
        "Counted, not reported: /acme-lint acme-fix, /acme-audit acme-fix. Not actions below; run each if it did not run.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-fix",
      ].join("\n"),
    );
  });

  test("a declared type's reviews are listed from its folder", () => {
    const given: Given = { steps: { draft: ["acme-draft"] }, files: ["brief.md"] };

    expect(handoff(NOTES, "draft", "acme-glossary", given)).toBe(
      [
        "## Next steps",
        "1. Review brief: notes/acme-glossary/brief.md",
        "2. After your review: /acme-build acme-glossary",
      ].join("\n"),
    );
  });
});

describe("the hand-off where a change stands", () => {
  const workflow = defaultWorkflow();
  const where = (given: Given): string => render(standing(workflow, "acme-fix", given).handoff);

  test("names what is open in the stage the change is at", () => {
    expect(where({ tasks: [2, 4] })).toBe(
      "## Next steps\n1. /mate-apply-change acme-fix (2 tasks open)",
    );
  });

  test("offers the optional stages since the last required one", () => {
    expect(where({ tasks: [4, 4] })).toBe(
      [
        "Optional, any order: /mate-show-me acme-fix, /mate-simplify-code acme-fix.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-fix",
      ].join("\n"),
    );
  });

  test("a submitted change waits for its merge, then publication", () => {
    expect(where({ tasks: [4, 4], state: "submitted", unmerged: ["workset/acme-fix"] })).toBe(
      "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
    );
  });
});

describe("the hand-off as data", () => {
  const workflow = defaultWorkflow();

  test("a skill action carries its change and what is open", () => {
    expect(data(workflow, "apply", "acme-fix", { tasks: [2, 4] })).toEqual({
      actions: [
        { kind: "skill", skill: "mate-apply-change", change: "acme-fix", note: "2 tasks open" },
      ],
      optional: [],
      counted: [],
    });
  });

  test("reviews are text actions, the stage after them marked afterReview", () => {
    expect(data(workflow, "propose", "acme-fix", { tasks: [0, 3] }).actions).toEqual([
      { kind: "text", text: "Review specs: openspec/changes/acme-fix/specs/" },
      { kind: "text", text: "Review tasks: openspec/changes/acme-fix/tasks.md" },
      { kind: "skill", skill: "mate-apply-change", change: "acme-fix", afterReview: true },
    ]);
  });

  test("a merge is a text action, publication a skill without a change", () => {
    const given: Given = { tasks: [4, 4], state: "submitted", unmerged: ["workset/acme-fix"] };

    expect(data(workflow, "submit", "acme-fix", given).actions).toEqual([
      { kind: "text", text: "Merge workset/acme-fix" },
      { kind: "skill", skill: "mate-publish-artifact" },
    ]);
  });

  test("optional and counted stages are skill actions", () => {
    const steps = { apply: ["mate-apply-change", "acme-verify"] };
    const result = data(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps });

    expect(result.optional).toEqual([{ kind: "skill", skill: "acme-demo", change: "acme-login" }]);
    expect(result.counted).toEqual([
      { kind: "skill", skill: "acme-security-review", change: "acme-login" },
    ]);
  });

  test("nothing follows: every list is empty", () => {
    expect(data(workflow, "publish", "acme-fix", { state: "submitted" })).toEqual({
      actions: [],
      optional: [],
      counted: [],
    });
  });
});

describe("rendering", () => {
  const workflow = defaultWorkflow();

  test("another runtime's prefix on every invocation, and no path", () => {
    const steps = { apply: ["mate-apply-change", "acme-verify"] };
    const text = renderHandoff(
      data(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps }),
      "opencode",
    );

    expect(text).toBe(
      [
        "Counted, not reported: @acme-security-review acme-login. Not an action below; run it if it did not run.",
        "Optional: @acme-demo acme-login.",
        "",
        "## Next steps",
        "1. @mate-submit-change acme-login",
      ].join("\n"),
    );
    const reviews = renderHandoff(data(workflow, "propose", "acme-fix", { tasks: [0, 3] }), "pi");
    expect(reviews).toContain("1. Review specs: openspec/changes/acme-fix/specs/");
    expect(reviews).toContain("3. After your review: /skill:mate-apply-change acme-fix");
  });

  test("the hand-off as next:, optional: and counted lines", () => {
    expect(handoffLines(data(workflow, "apply", "acme-fix", { tasks: [4, 4] }), "claude")).toEqual([
      "next: /mate-submit-change acme-fix",
      "optional: /mate-show-me acme-fix, /mate-simplify-code acme-fix.",
    ]);
    const steps = { apply: ["mate-apply-change", "acme-verify"] };
    expect(
      handoffLines(data(DECLARED, "apply", "acme-login", { tasks: [4, 4], steps }), "codex"),
    ).toEqual([
      "next: $mate-submit-change acme-login",
      "optional: $acme-demo acme-login.",
      "Counted, not reported: $acme-security-review acme-login. Not an action below; run it if it did not run.",
    ]);
    expect(
      handoffLines(data(workflow, "publish", "acme-fix", { state: "submitted" }), "claude"),
    ).toEqual([]);
  });
});

describe("what keeps the stage open", () => {
  const workflow = defaultWorkflow();
  const facts = (done: number, total: number, valid = true): PathProgress => ({
    steps: {},
    plan: { valid, totalTasks: total, completedTasks: done },
  });

  test.each([
    [facts(0, 0, false), "propose", "the change does not validate"],
    [facts(0, 0), "propose", "no tasks"],
    [facts(0, 3), "review", null],
    [facts(2, 3), "apply", "1 task open"],
    [facts(3, 3), "submit", "not submitted"],
    [{ ...facts(3, 3), state: "submitted" as const }, "publish", null],
  ])("%o is at %s", (given, stage, open) => {
    const position = pathPosition(workflow, given);
    expect([position.stage?.id, position.open]).toEqual([stage, open]);
  });

  test("an unfinished stage names its open work", () => {
    expect(unfinishedOf(workflow, facts(0, 0))).toEqual({ propose: "no tasks", apply: "no tasks" });
    expect(unfinishedOf(workflow, facts(2, 3))).toEqual({ apply: "1 task open" });
    expect(unfinishedOf(workflow, facts(3, 3))).toEqual({});
  });
});

describe("stagesBeforeWork and stepStage", () => {
  test("the built-in type has always passed the stages before propose", () => {
    expect(stagesBeforeWork(defaultWorkflow()).map((stage) => stage.id)).toEqual([
      "clarify-intent",
      "explore",
    ]);
    expect(stagesBeforeWork(NOTES)).toEqual([]);
  });

  test("a skill names the stage whose steps hold it", () => {
    expect(stepStage(DECLARED, "acme-verify")?.id).toBe("apply");
    expect(stepStage(DECLARED, "acme-missing")).toBeUndefined();
  });
});
