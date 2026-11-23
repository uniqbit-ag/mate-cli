import { describe, expect, test } from "bun:test";

import { parseWorkflow, type Workflow } from "./declaration";
import { pathPosition, type PathProgress } from "./position";
import { reportStep, type ReportedStep } from "./report";
import type { Work } from "./work";

function declared(source: string): Workflow {
  const verdict = parseWorkflow(source);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

const WORKFLOW = declared(`version: 1
stages:
  - id: explore
    steps: [{ skill: mate-explore-change }]
  - id: propose
    steps: [{ skill: mate-propose-change }]
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: polish
    optional: true
    steps: [{ skill: acme-polish }]
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }, { skill: acme-notify }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);

const IMPLEMENTED: PathProgress = {
  steps: {},
  plan: { valid: true, totalTasks: 2, completedTasks: 2 },
};

/** Work held in memory: each named piece's progress, and the names looked up. */
function memoryWork(items: Record<string, PathProgress>) {
  const lookups: string[] = [];
  const work: Work = {
    names: async () => Object.keys(items).sort(),
    async find(name) {
      lookups.push(name);
      const progress = items[name];
      if (!progress) return { problem: `${name} is no work.` };
      return {
        name,
        input: async () => ({ progress, subject: { name } }),
        async recordStep(stage, skill) {
          const steps = (progress.steps as Record<string, string[]>)[stage] ?? [];
          if (!steps.includes(skill)) steps.push(skill);
          progress.steps = { ...progress.steps, [stage]: steps };
        },
      };
    },
  };
  return { work, items, lookups };
}

function reported(result: ReportedStep | { problem: string }): ReportedStep {
  if ("problem" in result) throw new Error(result.problem);
  return result;
}

const firstSkill = (step: ReportedStep) => {
  const action = step.handoff.actions[0];
  return action?.kind === "skill" ? action.skill : undefined;
};

describe("reportStep", () => {
  test("records a step and leaves the stage's open steps", async () => {
    const { work, items } = memoryWork({ "acme-fix": { ...IMPLEMENTED } });
    const step = reported(await reportStep(work, WORKFLOW, "mate-apply-change", "acme-fix"));
    expect(step).toMatchObject({
      stage: "apply",
      change: "acme-fix",
      step: "mate-apply-change",
      recorded: true,
      remaining: ["acme-verify"],
      complete: false,
    });
    expect(items["acme-fix"]!.steps).toEqual({ apply: ["mate-apply-change"] });
    expect(firstSkill(step)).toBe("acme-verify");
  });

  test("an optional stage records nothing", async () => {
    const { work, items } = memoryWork({ "acme-fix": { ...IMPLEMENTED } });
    const step = reported(await reportStep(work, WORKFLOW, "acme-polish", "acme-fix"));
    expect(step).toMatchObject({ stage: "polish", recorded: false, remaining: [], complete: true });
    expect(items["acme-fix"]!.steps).toEqual({});
  });

  test("submit records nothing from its Mate stage skill on and follows the chain", async () => {
    const { work, items } = memoryWork({
      "acme-fix": { ...IMPLEMENTED, steps: {}, state: "submitted" },
    });
    const step = reported(await reportStep(work, WORKFLOW, "mate-submit-change", "acme-fix"));
    expect(step).toMatchObject({ recorded: false, remaining: ["acme-notify"] });
    expect(firstSkill(step)).toBe("acme-notify");
    expect(items["acme-fix"]!.steps).toEqual({});
  });

  test("publish looks for no work", async () => {
    const { work, lookups } = memoryWork({});
    const step = reported(await reportStep(work, WORKFLOW, "mate-publish-artifact", "acme-fix"));
    expect(step).toMatchObject({ stage: "publish", recorded: false, remaining: [] });
    expect(lookups).toEqual([]);
  });

  test("missing work up to the path's first required stage hands off by stage order", async () => {
    const { work } = memoryWork({});
    const step = reported(await reportStep(work, WORKFLOW, "mate-explore-change", "acme-new"));
    expect(step).toMatchObject({ recorded: false, change: "acme-new" });
    expect(step.handoff.actions[0]).toEqual({
      kind: "skill",
      skill: "mate-propose-change",
      change: "acme-new",
    });
  });

  test("missing work past that stage is a problem", async () => {
    const { work } = memoryWork({ "acme-fix": { ...IMPLEMENTED } });
    expect(await reportStep(work, WORKFLOW, "mate-apply-change", "acme-fxi")).toEqual({
      problem: "acme-fxi is no work.",
    });
  });

  test("a skill that is no step is a problem naming the steps", async () => {
    const { work } = memoryWork({});
    const result = await reportStep(work, WORKFLOW, "acme-unknown", "acme-fix");
    expect("problem" in result && result.problem).toContain(
      "acme-unknown is no step of the Delivery Path; the steps are explore (mate-explore-change)",
    );
  });

  test("remaining follows the rule mate workflow next --after uses", async () => {
    for (const [skill, progress] of [
      ["mate-apply-change", { ...IMPLEMENTED }],
      ["mate-submit-change", { ...IMPLEMENTED, steps: {}, state: "submitted" as const }],
    ] as const) {
      const { work, items } = memoryWork({ "acme-fix": progress });
      const step = reported(await reportStep(work, WORKFLOW, skill, "acme-fix"));
      const after = pathPosition(WORKFLOW, items["acme-fix"]!, { name: "acme-fix" }, skill);
      expect(after.remaining).toEqual(step.remaining);
      expect(after.handoff).toEqual(step.handoff);
      expect(firstSkill(step)).toBe(step.remaining[0]);
    }
  });
});
