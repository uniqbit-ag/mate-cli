/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { Workflow } from "./index";
import { workflowPlan, workflowSteps } from "./steps";

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    topology: null,
    warnings: [],
    ...overrides,
  };
}

function render(data: StudioCompanionPayload = payload()): string {
  return String(<Workflow payload={data} />);
}

describe("workflowPlan", () => {
  it("starts with optional pre-explore and ends with artifact publish", () => {
    const plan = workflowPlan();
    expect(plan.start.id).toBe("pre-explore");
    expect(plan.finish.id).toBe("finish");
    expect(plan.start.title).toBe("pre-explore");
    expect(plan.finish.title).toBe("mate artifact publish");
  });

  it("offers full and minimal schema profiles", () => {
    const plan = workflowPlan();
    expect(plan.branches.map((branch) => branch.profile)).toEqual(["mate-v1", "mate-minimal"]);
    expect(plan.branches[0]?.steps.map((step) => step.id)).toEqual([
      "explore",
      "proposal",
      "specs",
      "design",
      "tasks",
      "apply",
    ]);
    expect(plan.branches[1]?.steps.map((step) => step.id)).toEqual([
      "propose",
      "specs",
      "tasks",
      "apply",
    ]);
    expect(plan.branches[1]?.description).toContain("only specs and tasks");
    expect(plan.shared.map((step) => step.id)).toEqual(["simplify", "archive"]);
  });

  it("flattens either profile into an executable sequence", () => {
    expect(workflowSteps("mate-v1").map((step) => step.id)).toEqual([
      "pre-explore",
      "explore",
      "proposal",
      "specs",
      "design",
      "tasks",
      "apply",
      "simplify",
      "archive",
      "finish",
    ]);
    expect(workflowSteps("mate-minimal").map((step) => step.id)).toEqual([
      "pre-explore",
      "propose",
      "specs",
      "tasks",
      "apply",
      "simplify",
      "archive",
      "finish",
    ]);
  });

  it("keeps the optional pre-explore choices before either profile", () => {
    const step = workflowPlan().start;
    expect(step.badges).toEqual(["optional", "skill"]);
    expect(step.what).toContain("Clarifies intent");
    expect(step.what).toContain("confidence");
    expect(step.what).toContain("explicit confirmation");
    expect(step.prompt).toContain("/mate-grill-me");
    expect(step.prompt).toContain("/mate-interview-me");
    expect(step.alternatives?.map((alternative) => alternative.name)).toEqual([
      "mate-interview-me",
      "mate-grill-me",
    ]);
    expect(step.alternatives?.[0]?.description).toContain("Difference: guided");
    expect(step.alternatives?.[0]?.description).toContain("Best when:");
    expect(step.alternatives?.[1]?.description).toContain("Difference: adversarial");
    expect(step.alternatives?.[1]?.description).toContain("Best when:");
    expect(step.prompt).toContain("<change-name>");
  });

  it("leaves only the explicit skip path when no pre-explore skill is available", () => {
    expect(workflowPlan([]).start.alternatives).toEqual([]);
  });

  it("shows the skill invocation needed for each profile", () => {
    const full = workflowSteps("mate-v1");
    const minimal = workflowSteps("mate-minimal");
    expect(full.find((step) => step.id === "explore")?.prompt).toBe(
      "/openspec-explore (use schema: mate-v1) for <change-name>",
    );
    expect(full.find((step) => step.id === "proposal")?.prompt).toBe(
      "/openspec-propose (use schema: mate-v1) for <change-name>",
    );
    expect(minimal.find((step) => step.id === "propose")?.prompt).toBe(
      "/openspec-propose (use schema: mate-minimal) for <change-name>",
    );
    expect(minimal.find((step) => step.id === "specs")?.prompt).toBe(
      "Review specs/ (use schema: mate-minimal) for <change-name>",
    );
    expect(full.find((step) => step.id === "apply")?.prompt).toBe(
      "/openspec-apply-change (use schema: mate-v1) for <change-name>",
    );
    expect(full.find((step) => step.id === "apply")?.copyPrompt).toBe(
      "/openspec-apply-change (use schema: mate-v1) for",
    );
    expect(full.find((step) => step.id === "apply")?.sessionBreakBefore).toBe(true);
    expect(full.find((step) => step.id === "simplify")?.sessionBreakBefore).toBe(true);
    expect(minimal.find((step) => step.id === "apply")?.sessionBreakBefore).toBe(true);
    expect(full.find((step) => step.id === "explore")?.sessionBreakBefore).toBeUndefined();
    expect(full.find((step) => step.id === "finish")?.prompt).toBe(
      "/mate-artifact-publish for <change-name>",
    );
    expect(full.find((step) => step.id === "archive")?.prompt).toBe(
      "/openspec-archive-change for <change-name>",
    );
    expect(full.find((step) => step.id === "archive")?.copyPrompt).toBe(
      "/openspec-archive-change for",
    );
    expect(full.find((step) => step.id === "specs")?.badges).toEqual(["human-in-loop", "openspec"]);
    expect(full.find((step) => step.id === "design")?.badges).toEqual([
      "human-in-loop",
      "openspec",
    ]);
    expect(full.find((step) => step.id === "tasks")?.badges).toEqual(["human-in-loop", "openspec"]);
    expect(full.find((step) => step.id === "explore")?.badges).toEqual(["skill", "openspec"]);
    expect(full.find((step) => step.id === "proposal")?.badges).toEqual(["skill", "openspec"]);
    expect(full.find((step) => step.id === "apply")?.badges).toEqual(["skill", "openspec"]);
    expect(minimal.find((step) => step.id === "propose")?.badges).toEqual(["skill", "openspec"]);
    expect(minimal.find((step) => step.id === "apply")?.badges).toEqual(["skill", "openspec"]);
    expect(minimal.find((step) => step.id === "specs")?.badges).toEqual([
      "human-in-loop",
      "openspec",
    ]);
    expect(minimal.find((step) => step.id === "tasks")?.badges).toEqual([
      "human-in-loop",
      "openspec",
    ]);
  });

  it("states what every stage does and why it is in the sequence", () => {
    for (const step of workflowSteps()) {
      expect({ id: step.id, what: step.what.length > 0 }).toEqual({ id: step.id, what: true });
      expect({ id: step.id, why: step.why.length > 0 }).toEqual({ id: step.id, why: true });
      expect(step.what).not.toBe(step.why);
    }
    const finish = workflowPlan().finish;
    expect(finish.what).toContain("committed, tagged, and pushed");
    expect(finish.what).toContain("delta specs");
    expect(finish.why).toContain("only sanctioned completion");
  });

  it("keeps the change placeholder in every prompt", () => {
    const plan = workflowPlan();
    const steps = [
      plan.start,
      ...plan.branches.flatMap((branch) => branch.steps),
      ...plan.shared,
      plan.finish,
    ];
    expect(steps.every((step) => step.prompt.includes("<change-name>"))).toBe(true);
    expect(steps.every((step) => !step.copyPrompt.includes("<change-name>"))).toBe(true);
    expect(
      plan.start.alternatives?.every(
        (alternative) => !alternative.copyPrompt.includes("<change-name>"),
      ),
    ).toBe(true);
  });
});

describe("Workflow", () => {
  it("renders the command transcript with schema tabs", () => {
    const markup = render();
    expect(markup).toContain('<div class="workflow-eyebrow">Workflow</div>');
    expect(markup).toContain('class="workflow-console"');
    expect(markup).not.toContain("mate workflow --read-only");
    expect(markup).not.toContain('if planning_depth = "full"');
    expect(markup).not.toContain('if planning_depth = "minimal"');
    expect(markup.match(/class="workflow-console-branch-rule-description"/g)).toHaveLength(2);
    expect(markup.match(/data-workflow-schema-profile/g)).toHaveLength(2);
    expect(markup.match(/data-workflow-schema-panel/g)).toHaveLength(2);
    expect(markup).toContain('data-workflow-schema-panel="mate-v1" data-active="true"');
    expect(markup).toContain('data-workflow-schema-panel="mate-minimal" data-active="false"');
  });

  it("keeps workflow context and copy controls in the transcript", () => {
    const markup = render();
    expect(markup.match(/class="runway-step-copy"/g)).toHaveLength(11);
    expect(markup.match(/class="workflow-option-list"/g)).toHaveLength(1);
    expect(markup.match(/class="workflow-option"/g)).toHaveLength(2);
    expect(markup.match(/<span>\$<\/span>/g)).toHaveLength(11);
    expect(markup).toContain("<code>/mate-interview-me for &lt;change-name&gt;</code>");
    expect(markup).toContain("<code>/mate-grill-me for &lt;change-name&gt;</code>");
    expect(markup.match(/class="workflow-session-break"/g)).toHaveLength(3);
    expect(markup).toContain("The desired change, its scope, and the risk involved are clear.");
    expect(markup).not.toContain("intent = clear");
    expect(markup).not.toContain("planning_depth = choose");
    expect(markup).toContain("solution, repository evidence, or risk still needs exploration");
    expect(markup).toContain("intent and scope are clear");
    expect(markup).toContain("pre-explore");
    expect(markup).toContain("mate simplify code");
    expect(markup).toContain("openspec archive change");
    expect(markup).toContain("/openspec-archive-change for &lt;change-name&gt;");
    expect(markup).toContain('data-copy="/openspec-archive-change for"');
    expect(markup.match(/class="workflow-console-divider"/g)).toHaveLength(2);
    expect(markup).toContain("feature is on production");
    expect(markup).toContain("Human review");
    expect(markup).not.toContain('data-copy-label="specs prompt"');
    expect(markup).not.toContain('data-copy-label="design prompt"');
    expect(markup).not.toContain('data-copy-label="tasks prompt"');
    expect(markup).toContain("for &lt;change-name&gt;");
    expect(markup).toContain('data-copy="/openspec-apply-change (use schema: mate-v1) for"');
    expect(markup).not.toMatch(/data-copy="[^"]*change-name/);
    expect(markup).toContain("Skip pre-explore");
  });

  it("renders the built-in workflow without a resolved schema", () => {
    const markup = render(payload());
    expect(markup).not.toContain("mate workflow --read-only");
    expect(markup).toContain("mate-v1");
    expect(markup).toContain("mate-minimal");
  });
});
